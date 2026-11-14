import React, { useState, useRef, useEffect } from 'react';
import {
  Send, Paperclip, X, AlertTriangle, RotateCcw, Trash2, Download,
  Box, FileCode, Loader2, Eye, Plus, Folder
} from 'lucide-react';
import { useWorkspaceStore } from '../../../app/store/useWorkspaceStore';
import { use2DWorkspaceStore } from '../../../app/store/use2DWorkspaceStore';
import { use3DWorkspaceStore } from '../../../app/store/use3DWorkspaceStore';
import { useAuthStore } from '../../../app/store/useAuthStore';
import { apiClient, getStaticFileUrl } from '../../../services/api/client';
import { generationApiService, type Edit3DRequest } from '../../../services/api/generation';
import { projectsApiService } from '../../../services/api/projects';
import { useSettingsStore } from '../../../app/store/useSettingsStore';
import { SaveProjectModal } from '../../../components/dialogs/SaveProjectModal';
import { FileAttachment, ChatMessage } from '../../../types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { agentService, type AgentChatRequest } from '../../../services/api/agent';
import { classifyText2DIntent } from './textIntent';

const isImageFile = (filename: string) =>
  ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].some(ext =>
    filename.toLowerCase().endsWith(`.${ext}`)
  );

interface JobEvent {
  job_id: string;
  status: 'queued' | 'processing' | 'understanding' | 'generating' | 'geometry_processing' | 'optimizing' | 'validating' | 'completed' | 'failed';
  stage_name: string;
  progress: number;
  message: string;
  output_file_path?: string;
  output_filename?: string;
  dxf_content?: string;   // For 2D external API responses
  dxf_url?: string;       // For 2D external API responses
}

export const AIAssistantSidebar: React.FC = () => {
  const { viewMode, setExportModalOpen, loadDXFContent, activeProjectId, activeProjectName, setActiveProjectId } = useWorkspaceStore();
  const { user } = useAuthStore();
  const is3D = viewMode === 'workspace_3d';

  const store2D = use2DWorkspaceStore();
  const store3D = use3DWorkspaceStore();

  const store = is3D ? store3D : store2D;
  const { chatMessages, attachments, isGenerating, inputErrors } = store;

  const folderInputRef = useRef<HTMLInputElement>(null);

  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // Get folder name from webkitRelativePath
    const firstPath = files[0].webkitRelativePath || '';
    const folderName = firstPath.split('/')[0] || 'Selected Folder';

    console.log(`[FolderPicker] Selected folder: ${folderName}, files count: ${files.length}`);

    // Get local folder path if available (firstPath includes relative path)
    const firstFile = files[0] as any;
    const folderPath = firstFile?.path ? firstFile.path.replace(/[/\\][^/\\]+$/, '') : undefined;

    // Create or set project with the selected folder name
    try {
      const res = await projectsApiService.createProject({
        name: folderName,
        description: `Local folder project: ${folderName}`,
        type: is3D ? '3D' : '2D',
        file_path: folderPath
      });
      if (res && res.id) {
        setActiveProjectId(res.id, res.name);
        // Upload DXF / STL files found in this folder automatically in the background
        let firstUploadedPath: string | null = null;
        const uploadedList: Array<{
          id: string;
          filename: string;
          file_path: string;
          file_size?: number;
          format?: string;
        }> = [];

        const isStl = (name: string) => name.toLowerCase().endsWith('.stl');
        const isDxf = (name: string) => name.toLowerCase().endsWith('.dxf');

        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const matchesWorkspace = is3D ? isStl(file.name) : isDxf(file.name);
          if (matchesWorkspace) {
            try {
              const formData = new FormData();
              formData.append('file', file);
              const upRes = await apiClient.post('/files/upload', formData, {
                headers: { 'Content-Type': 'multipart/form-data' }
              });
              const savedPath = upRes.data?.saved_path || upRes.data?.file_path;
              if (savedPath) {
                if (!firstUploadedPath) firstUploadedPath = savedPath;
                uploadedList.push({
                  id: `folder_file_${Date.now()}_${i}`,
                  filename: file.name,
                  file_path: savedPath,
                  file_size: file.size,
                  format: isStl(file.name) ? 'stl' : 'dxf'
                });
              }
            } catch (err) {
              console.error('Failed to upload file from folder:', file.name, err);
            }
          }
        }

        setFolderFiles(uploadedList);

        // Auto-load the first matching file onto Viewport if available
        if (firstUploadedPath) {
          console.log(`[FolderPicker] Auto-loading first workspace file onto Viewport: ${firstUploadedPath}`);
          useWorkspaceStore.getState().loadFile(firstUploadedPath, is3D ? '3D' : '2D');
          store.setActiveFile(firstUploadedPath);
        }
      }
    } catch (err) {
      console.error('Failed to create project from folder:', err);
    }
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevMsgCountRef = useRef(chatMessages.length);

  const [inputPrompt, setInputPrompt] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [fileValidationError, setFileValidationError] = useState<string | null>(null);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);

  // Stable agent session ID — one per browser session, resets when project changes
  const agentSessionId = useRef<string>(
    `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );
  const [isSaveModalOpen, setIsSaveModalOpen] = useState<boolean>(false);
  const [pendingSaveFilePath, setPendingSaveFilePath] = useState<string | undefined>(undefined);
  const [isFolderPopoverOpen, setIsFolderPopoverOpen] = useState<boolean>(false);
  const [folderFiles, setFolderFiles] = useState<Array<{
    id: string;
    filename: string;
    file_path: string;
    file_size?: number;
    format?: string;
  }>>([]);

  // ── Bug #5: Pending part waiting for add/replace decision ────────────────
  const [pendingPartDecision, setPendingPartDecision] = useState<{
    filePath: string;
    fileName: string;
    partName: string;
    decisionMsgId: string;
  } | null>(null);

  /** Derive a short, human-readable name from the user prompt (Bug #4) */
  const cleanPartName = (prompt: string, partCount: number): string => {
    const clean = prompt
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .slice(0, 3)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
    return clean || `Part ${partCount}`;
  };

  // Check if 2D inputs are valid
  const is2DInputsValid = is3D ? true : !inputErrors.width && !inputErrors.height && !inputErrors.toolDiameter;

  const allowedExts = is3D ? ['.stl', '.png', '.jpg', '.jpeg', '.webp'] : ['.dxf', '.png', '.jpg', '.jpeg', '.webp'];
  const acceptAttribute = is3D ? '.stl,.png,.jpg,.jpeg,.webp' : '.dxf,.png,.jpg,.jpeg,.webp';

  // Smooth scroll only when new messages are added or generation starts
  useEffect(() => {
    if (chatMessages.length > prevMsgCountRef.current || isGenerating) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevMsgCountRef.current = chatMessages.length;
  }, [chatMessages.length, isGenerating]);

  // Load chat history from DB when activeProjectId changes
  useEffect(() => {
    if (!activeProjectId) return;

    let isMounted = true;
    projectsApiService.getProjectMessages(activeProjectId, is3D ? '3D' : '2D')
      .then((msgs) => {
        if (!isMounted || !msgs || msgs.length === 0) return;
        const formatted: ChatMessage[] = msgs.map(m => ({
          id: m.id || `msg_${Date.now()}_${Math.random()}`,
          sender: (m.sender === 'user' ? 'user' : 'ai') as 'user' | 'ai',
          text: m.text || '',
          timestamp: m.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          attachments: m.attachments || []
        }));
        if (is3D) {
          store3D.setChatMessages(formatted);
        } else {
          store2D.setChatMessages(formatted);
        }
      })
      .catch((err) => console.warn('Failed to restore project chat history:', err));

    return () => {
      isMounted = false;
    };
  }, [activeProjectId, is3D]);

  useEffect(() => {
    return () => { eventSourceRef.current?.close(); };
  }, []);

  const addMessage = (msg: ChatMessage) => {
    store.addChatMessage(msg);
    const curProjId = useWorkspaceStore.getState().activeProjectId;
    if (curProjId) {
      projectsApiService.saveProjectMessage(curProjId, {
        sender: msg.sender,
        text: msg.text,
        attachments: msg.attachments,
        design_type: is3D ? '3D' : '2D'
      }).catch((err) => console.warn('Failed to save message to DB:', err));
    }
  };

  const handlePostGeneration = (filePath?: string, inlineBase64?: string) => {
    const curProjId = useWorkspaceStore.getState().activeProjectId;

    // ── Electron-native Save-As (preferred — works in packaged app) ──────────
    const electronSave = (window as any).electronAPI?.saveGeneratedFile;
    if (electronSave && (filePath || inlineBase64)) {
      (async () => {
        try {
          const fileName = (filePath ? filePath.split(/[/\\]/).pop() : undefined)
            || (is3D ? 'generated_model.stl' : 'generated_blueprint.dxf');
          const res = await electronSave({
            sourcePath: filePath || null,
            base64Data: inlineBase64 || null,
            textData: inlineBase64 || null,
            defaultName: fileName
          });
          if (res?.saved) {
            console.log(`[Save] File saved via Electron IPC → ${res.destPath}`);
            if (res.destPath) {
              useWorkspaceStore.getState().setActiveFilePath(res.destPath);
            }
          } else if (res?.error) {
            console.error('[Save] Electron IPC save error:', res.error);
          }
          // res.saved === false means user cancelled — no error needed
        } catch (err) {
          console.error('[Save] Electron saveGeneratedFile threw:', err);
        }
      })();

    } else if (filePath) {
      // ── Browser blob fallback (dev mode / no Electron) ────────────────────
      const { autoSaveToProjectFolder } = useSettingsStore.getState();
      if (autoSaveToProjectFolder) {
        (async () => {
          try {
            const fullUrl = getStaticFileUrl(filePath);
            const fileName = filePath.split(/[/\\]/).pop() || (is3D ? 'generated_model.stl' : 'generated_blueprint.dxf');
            const response = await fetch(fullUrl);
            const blob = await response.blob();
            const blobUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(blobUrl);
            console.log(`[AutoSave] Browser blob download: ${fileName}`);
          } catch (err) {
            console.error('[AutoSave] Browser blob download failed:', err);
          }
        })();
      }
    }

    if (!curProjId) {
      setPendingSaveFilePath(filePath);
      setIsSaveModalOpen(true);
    } else if (filePath) {
      projectsApiService.updateProject(curProjId, { file_path: filePath })
        .catch((err) => console.warn('Failed to update project file_path:', err));
    }
  };

  const handleProjectSaved = async (newProjectId: string, newProjectName: string) => {
    setActiveProjectId(newProjectId, newProjectName);
    // Backfill current chat messages to newly created project
    const currentMsgs = is3D ? store3D.chatMessages : store2D.chatMessages;
    for (const m of currentMsgs) {
      try {
        await projectsApiService.saveProjectMessage(newProjectId, {
          sender: m.sender,
          text: m.text,
          attachments: m.attachments,
          design_type: is3D ? '3D' : '2D'
        });
      } catch (err) {
        console.warn('Failed to backfill message:', err);
      }
    }
  };

  const isSendingRef = useRef(false);
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Tracks when actual HTTP request was sent — used to measure UI lag vs real completion
  const requestStartTimeRef = useRef<number>(0);
  // Unique request ID for each generation to track duplicates
  const currentRequestIdRef = useRef<string | null>(null);

  const clearProgressTimer = () => {
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
  };

  const startProgressTimer = (requestId: string) => {
    clearProgressTimer();
    console.log(`[REQUEST ID ${requestId}] Starting progress timer`);
    let elapsedSeconds = 0;
    progressIntervalRef.current = setInterval(() => {
      elapsedSeconds += 5;
      if (elapsedSeconds >= 240) { // 4 minutes
        store.setGenerating(true, 'generating', 95, 'Finalizing model and optimizing mesh...');
      } else if (elapsedSeconds >= 180) { // 3 minutes
        store.setGenerating(true, 'generating', 85, 'Finalizing geometry and running mesh decimation...');
      } else if (elapsedSeconds >= 120) { // 2 minutes
        store.setGenerating(true, 'generating', 70, 'Processing 3D geometry and applying constraints...');
      } else if (elapsedSeconds >= 60) { // 1 minute
        store.setGenerating(true, 'generating', 50, is3D ? 'Generating 3D model (this may take 2-4 minutes)...' : 'Calculating toolpaths and machining contours...');
      } else if (elapsedSeconds >= 30) { // 30 seconds
        store.setGenerating(true, 'generating', 30, is3D ? 'Uploading parameters to AI model and generating mesh...' : 'Drafting blueprint and applying manufacturing standards...');
      } else if (elapsedSeconds >= 15) {
        store.setGenerating(true, 'generating', 15, is3D ? 'Initializing 3D generation pipeline...' : 'Analyzing design requirements...');
      }
    }, 5000);
  };

  /**
   * Immediately finalize a completed generation when the backend already returned
   * the output in the HTTP response body (synchronous pipeline case).
   * This avoids the de-sync where the cosmetic timer kept running after the job
   * was already done on the server.
   */
  /**
   * Returns true if there are "real" user-generated parts beyond the default placeholder.
   * Used for the add/replace decision (Bug #5).
   */
  const hasExistingRealParts = (): boolean => {
    if (!is3D) return false;
    const parts = (store as typeof store3D).parts;
    // Default placeholder is 'part-main'; anything beyond that = real content
    return parts.some(p => p.id !== 'part-main' || p.filePath);
  };

  /**
   * Finish adding a new part — either appending or replacing (Bug #5).
   * Called from both handleImmediateCompletion and the SSE completed handler.
   */
  const finalisePart = (
    filePath: string,
    fileName: string,
    partName: string,
    mode: 'add' | 'replace'
  ) => {
    const s3d = store as typeof store3D;
    store.setActiveFile(filePath);

    if (mode === 'replace') {
      // Remove all existing parts, then add the new one
      const existingIds = s3d.parts.map(p => p.id);
      existingIds.forEach(id => s3d.removePart(id));
    } else {
      // Remove default empty placeholder if it has no filePath
      s3d.parts
        .filter(p => !p.filePath && p.id === 'part-main')
        .forEach(p => s3d.removePart(p.id));
    }

    s3d.addPart({
      id: `part_${Date.now()}`,
      name: partName,
      filePath,
      visible: true,
      isAssembled: false,
      dimensions: { length: 100, width: 100, height: 50 },
      position: { x: 0, y: 0, z: 0 },
      color: '#9ca3af'
    });
  };

  const handleImmediateCompletion = (outputFilePath: string, outputFilename?: string) => {
    const currentRequestId = currentRequestIdRef.current;
    const uiLagMs = Date.now() - requestStartTimeRef.current;
    console.log(
      `[REQUEST ID ${currentRequestId}] Backend completed — UI updated in ${uiLagMs}ms after HTTP response.`,
      { outputFilePath, outputFilename }
    );

    // Validate file exists before proceeding
    console.log(`[REQUEST ID ${currentRequestId}] Validating output file: ${outputFilePath}`);
    if (!outputFilePath) {
      console.error(`[REQUEST ID ${currentRequestId}] ERROR: No output file path provided`);
      throw new Error("No output file path provided");
    }

    clearProgressTimer();
    store.setGenerating(false);
    isSendingRef.current = false;
    currentRequestIdRef.current = null;
    store.setActiveFile(outputFilePath);

    console.log(`[REQUEST ID ${currentRequestId}] File set as active, triggering UI update`);
    if (!is3D) {
      useWorkspaceStore.getState().loadFile(outputFilePath, '2D');
    }

    if (is3D) {
      const partCount = (store as typeof store3D).parts.length + 1;
      const partName = cleanPartName(inputPrompt || outputFilename || 'Generated Part', partCount);

      console.log(`[REQUEST ID ${currentRequestId}] Processing 3D result for workspace: ${outputFilePath}`);

      finalisePart(outputFilePath, outputFilename || '', partName, 'replace');
    }

    const doneMsg: ChatMessage = {
      id: `msg_done_${Date.now()}`,
      sender: 'ai',
      text: `✨ ${is3D ? '3D CAD model' : '2D DXF blueprint'} successfully generated and loaded into workspace!\n\nYou can review and adjust dimensions from the control panel, then click **Export** to save your manufacturing file.`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    addMessage(doneMsg);
    handlePostGeneration(outputFilePath);

    console.log(`[REQUEST ID ${currentRequestId}] GENERATION END - SUCCESS - File processing complete`);
  };

  const subscribeToJob = (jobId: string, requestId?: string) => {
    const reqId = requestId || currentRequestIdRef.current || 'unknown';

    // Prevent subscribing if this request is no longer active
    if (currentRequestIdRef.current && currentRequestIdRef.current !== reqId) {
      console.warn(`[REQUEST ID ${reqId}] Job subscription blocked - request ID mismatch. Current: ${currentRequestIdRef.current}, Requested: ${reqId}`);
      return;
    }

    console.log(`[REQUEST ID ${reqId}] Subscribing to job stream: ${jobId}`);

    eventSourceRef.current?.close();
    const es = generationApiService.streamJobProgress(jobId);
    eventSourceRef.current = es;

    const safetyTimeout = setTimeout(() => {
      console.error(`[REQUEST ID ${reqId}] Job timed out after 5 minutes`);
      es.close();
      clearProgressTimer();
      store.setGenerating(false);
      isSendingRef.current = false;
      currentRequestIdRef.current = null;

      // Add timeout error message
      const timeoutMsg: ChatMessage = {
        id: `msg_timeout_${Date.now()}`,
        sender: 'ai',
        text: `⏱️ Job timed out after 5 minutes. The generation process may still be running on the server. Please check your project files or try again.`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      addMessage(timeoutMsg);
      console.log(`[REQUEST ID ${reqId}] GENERATION END - TIMEOUT`);
    }, 300000); // 5 minutes max safety limit

    es.onmessage = (e) => {
      try {
        const evt: JobEvent = JSON.parse(e.data);
        console.log(`[REQUEST ID ${reqId}] Job progress event:`, evt);

        store.setGenerating(
          !['completed', 'failed'].includes(evt.status),
          evt.stage_name,
          evt.progress,
          evt.message,
          evt.job_id
        );
        if (evt.status === 'completed') {
          console.log(`[REQUEST ID ${reqId}] Job completed successfully via SSE`);
          clearTimeout(safetyTimeout);
          clearProgressTimer();
          es.close();
          store.setGenerating(false);
          isSendingRef.current = false;

          // Handle 2D external API response (dxf_content or dxf_url)
          if (!is3D && (evt.dxf_content || evt.dxf_url)) {
            if (evt.dxf_content) {
              loadDXFContent(evt.dxf_content, evt.output_filename || 'generated.dxf');
            } else if (evt.dxf_url) {
              const failMsg: ChatMessage = {
                id: `msg_fail_${Date.now()}`,
                sender: 'ai',
                text: `⚠️ The server returned a blueprint URL instead of direct file content. Please retry.`,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              };
              addMessage(failMsg);
              return;
            }
          } else if (evt.output_file_path) {
            // Traditional file path (for 3D or fallback)
            store.setActiveFile(evt.output_file_path);

            if (is3D) {
              const partCount = (store as typeof store3D).parts.length + 1;
              const partName = cleanPartName(inputPrompt || evt.output_filename || 'Generated Part', partCount);

              if (hasExistingRealParts()) {
                // ── Bug #5: ask user add or replace ──────────────────────────
                const decisionMsgId = `msg_decision_${Date.now()}`;
                setPendingPartDecision({
                  filePath: evt.output_file_path,
                  fileName: evt.output_filename || '',
                  partName,
                  decisionMsgId
                });
                addMessage({
                  id: decisionMsgId,
                  sender: 'ai',
                  text: `✅ New 3D model generated: **${partName}**\n\nA model already exists in your workspace. What would you like to do?`,
                  timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                });
                handlePostGeneration(evt.output_file_path);
                return;
              }

              finalisePart(evt.output_file_path, evt.output_filename || '', partName, 'add');
            }
          }

          const doneMsg: ChatMessage = {
            id: `msg_done_${Date.now()}`,
            sender: 'ai',
            text: `✨ ${is3D ? '3D CAD model' : '2D DXF blueprint'} successfully generated!\n\n📄 **File:** \`${evt.output_filename || 'output'}\` (Click below to view in viewport)`,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            attachments: evt.output_file_path ? [{
              id: `att_done_${Date.now()}`,
              filename: evt.output_filename || (is3D ? 'model.stl' : 'design.dxf'),
              file_path: evt.output_file_path,
              file_size: 0,
              format: is3D ? 'STL' : 'DXF',
              upload_timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            }] : undefined
          };
          addMessage(doneMsg);
          handlePostGeneration(evt.output_file_path);
          console.log(`[REQUEST ID ${reqId}] GENERATION END - SUCCESS (via SSE)`);
        } else if (evt.status === 'failed') {
          console.log(`[REQUEST ID ${reqId}] Job failed via SSE:`, evt.message);
          clearTimeout(safetyTimeout);
          clearProgressTimer();
          es.close();
          store.setGenerating(false);
          isSendingRef.current = false;
          currentRequestIdRef.current = null;
          const failMsg: ChatMessage = {
            id: `msg_fail_${Date.now()}`,
            sender: 'ai',
            text: `❌ Generation failed: ${evt.message || 'An unexpected error occurred during processing. Please check your connection and try again.'}`,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          };
          addMessage(failMsg);
        }
      } catch (err) {
        console.error(`[REQUEST ID ${reqId}] SSE parse error:`, err);
        const errorMsg: ChatMessage = {
          id: `msg_sse_error_${Date.now()}`,
          sender: 'ai',
          text: `⚠️ Connection error while tracking job progress. The job may still be running on the server.`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        addMessage(errorMsg);
      }
    };

    es.onerror = () => {
      console.error(`[REQUEST ID ${reqId}] SSE connection error`);
      clearTimeout(safetyTimeout);
      clearProgressTimer();
      es.close();
      store.setGenerating(false);
      isSendingRef.current = false;
      currentRequestIdRef.current = null;

      const errorMsg: ChatMessage = {
        id: `msg_connection_error_${Date.now()}`,
        sender: 'ai',
        text: `⚠️ Connection to server lost. The generation job may still be running. Please check your project files or try again.`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      addMessage(errorMsg);
    };
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setFileValidationError(null);
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    const lower = file.name.toLowerCase();
    const ext = file.name.split('.').pop() || '';

    if (file.size > 50 * 1024 * 1024) {
      setFileValidationError('File size exceeds the 50 MB limit.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    if (!allowedExts.some(v => lower.endsWith(v))) {
      setFileValidationError(`Format "${ext.toUpperCase()}" is not accepted here.`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await apiClient.post('/files/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      const data = res.data;
      const att: FileAttachment = {
        id: `att_${Date.now()}`,
        filename: file.name,
        file_path: data.saved_path,
        file_size: data.file_size,
        format: file.name.split('.').pop()?.toUpperCase() || 'FILE',
        upload_timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      store.addAttachment(att);
    } catch (err: any) {
      setFileValidationError(`Upload failed: ${err.message || 'Server error'}`);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSendMessage = async () => {
    if (isSendingRef.current) {
      console.warn('[Generation] Request blocked - already sending');
      return;
    }
    const userText = inputPrompt.trim();
    const currentAtts = [...attachments];
    if (!userText && currentAtts.length === 0) return;

    // Generate unique request ID for this generation
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    currentRequestIdRef.current = requestId;
    console.log(`[GENERATION START] Request ID: ${requestId}`);

    // Validate 2D inputs before generating
    if (!is3D) {
      const valid = (store as typeof store2D).validateInputs?.();
      if (valid === false) {
        const errMsg: ChatMessage = {
          id: `msg_valerr_${Date.now()}`,
          sender: 'ai',
          text: '⚠️ Please specify valid dimensions (Width X, Height Y, and Tool Diameter > 0) before generating.',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        store.addChatMessage(errMsg);
        return;
      }
    }

    isSendingRef.current = true;
    requestStartTimeRef.current = Date.now();
    setInputPrompt('');
    store.clearAttachments();
    setFileValidationError(null);

    console.log(`[REQUEST ID ${requestId}] Starting generation process`);

    const userMsg: ChatMessage = {
      id: `msg_${Date.now()}`,
      sender: 'user',
      text: userText || `[Attached file: ${currentAtts[0]?.filename}]`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      attachments: currentAtts
    };
    addMessage(userMsg);

    // ── 1. Immediate loading spinner & clear any previous timer ─────────────────
    clearProgressTimer();
    startProgressTimer(requestId);
    store.setGenerating(
      true,
      'generating',
      0,
      is3D
        ? 'Generating 3D model via Hunyuan3D API...'
        : 'Generating 2D CAD blueprint...'
    );

    try {
      const attachedFile = currentAtts[0];
      const hasImage = attachedFile && ['png', 'jpg', 'jpeg', 'webp'].some(ext =>
        attachedFile.filename.toLowerCase().endsWith(`.${ext}`)
      );
      const hasCAD = attachedFile && !hasImage;
      const activeFilePath = store.activeFilePath;
      const activeProjectId = useWorkspaceStore.getState().activeProjectId || undefined;

      // =========================================================================
      // 3D WORKSPACE ROUTING (Direct thin-client pass-through to 3D API)
      // =========================================================================
      if (is3D) {
        const s3d = store as typeof store3D;
        const dims = { height: s3d.height, width: s3d.width, length: s3d.length };

        // Workflow Decision Logic:
        // 1. existing model + prompt → EDIT workflow
        // 2. image only → IMAGE_TO_3D workflow
        // 3. prompt only → TEXT_TO_3D workflow

        // CAD attachment (STL) plus a prompt edits the open model.
        // An image plus a prompt also edits when a model is already open.
        const cadEditPath = hasCAD ? (activeFilePath || attachedFile?.file_path) : null;
        const isEditWorkflow = Boolean(
          userText && (cadEditPath || (hasImage && activeFilePath))
        );
        const editFilePath = cadEditPath || activeFilePath;

        if (isEditWorkflow) {
          // EDIT workflow: existing model + image + edit prompt
          console.log(`[REQUEST ID ${requestId}] Workflow: EDIT - existing model + edit prompt`);
          console.log(`[REQUEST ID ${requestId}] → POST /generation/edit-3d`);
          console.time(`[REQUEST ID ${requestId}] edit3D HTTP round-trip`);
          console.log(`[HTTP REQUEST ${requestId}] Sending to /generation/edit-3d`, {
            user_id: user?.id,
            project_id: activeProjectId,
            file_path: editFilePath,
            prompt: userText,
            dims
          });

          const res = await generationApiService.edit3D({
            user_id: user?.id,
            project_id: activeProjectId,
            file_path: editFilePath,
            prompt: userText,
            ...dims
          });

          console.timeEnd(`[REQUEST ID ${requestId}] edit3D HTTP round-trip`);
          console.log(`[HTTP RESPONSE ${requestId}] Received from /generation/edit-3d`, res);

          // Backend now always returns synchronous completed response
          if (res.status === 'completed' && res.output_file_path) {
            console.log(`[REQUEST ID ${requestId}] edit3D completed synchronously`);
            handleImmediateCompletion(res.output_file_path, res.output_filename);
            handlePostGeneration(res.output_file_path);
            console.log(`[REQUEST ID ${requestId}] GENERATION END - SUCCESS`);
            return;
          }

          // If backend returns job_id with processing status, subscribe to job stream
          if (res.status === 'processing' && res.job_id) {
            console.log(`[REQUEST ID ${requestId}] edit3D started as background job: ${res.job_id}`);
            subscribeToJob(res.job_id, requestId);
            return;
          }

          console.warn(`[REQUEST ID ${requestId}] Unexpected response structure:`, res);
          throw new Error(`Unexpected response from edit-3d API: ${JSON.stringify(res)}`);
        } else if (hasImage) {
          console.log(`[REQUEST ID ${requestId}] Workflow: IMAGE_TO_3D - image only`);
          console.log(`[REQUEST ID ${requestId}] → POST /generation/image-to-3d`);
          console.time(`[REQUEST ID ${requestId}] imageTo3D HTTP round-trip`);
          console.log(`[HTTP REQUEST ${requestId}] Sending to /generation/image-to-3d`, {
            user_id: user?.id,
            project_id: activeProjectId,
            image_path: attachedFile!.file_path,
            dims
          });

          const res = await generationApiService.imageTo3D({
            user_id: user?.id,
            project_id: activeProjectId,
            image_path: attachedFile!.file_path,
            ...dims
          });

          console.timeEnd(`[REQUEST ID ${requestId}] imageTo3D HTTP round-trip`);
          console.log(`[HTTP RESPONSE ${requestId}] Received from /generation/image-to-3d`, res);

          // Backend now always returns synchronous completed response
          if (res.status === 'completed' && res.output_file_path) {
            console.log(`[REQUEST ID ${requestId}] imageTo3D completed synchronously`);
            handleImmediateCompletion(res.output_file_path, res.output_filename);
            handlePostGeneration(res.output_file_path);
            console.log(`[REQUEST ID ${requestId}] GENERATION END - SUCCESS`);
            return;
          }

          // If backend returns job_id with processing status, subscribe to job stream
          if (res.status === 'processing' && res.job_id) {
            console.log(`[REQUEST ID ${requestId}] imageTo3D started as background job: ${res.job_id}`);
            subscribeToJob(res.job_id, requestId);
            return;
          }

          console.warn(`[REQUEST ID ${requestId}] Unexpected response structure:`, res);
          throw new Error(`Unexpected response from image-to-3d API: ${JSON.stringify(res)}`);
        } else {
          // TEXT_TO_3D workflow: prompt only
          console.log(`[REQUEST ID ${requestId}] Workflow: TEXT_TO_3D - prompt only`);
          console.log(`[REQUEST ID ${requestId}] → POST /generation/text-to-3d`);
          console.time(`[REQUEST ID ${requestId}] textTo3D HTTP round-trip`);
          console.log(`[HTTP REQUEST ${requestId}] Sending to /generation/text-to-3d`, {
            user_id: user?.id,
            project_id: activeProjectId,
            prompt: userText,
            dims
          });

          const res = await generationApiService.textTo3D({
            user_id: user?.id,
            project_id: activeProjectId,
            prompt: userText,
            ...dims
          });

          console.timeEnd(`[REQUEST ID ${requestId}] textTo3D HTTP round-trip`);
          console.log(`[HTTP RESPONSE ${requestId}] Received from /generation/text-to-3d`, res);

          // Backend now always returns synchronous completed response
          if (res.status === 'completed' && res.output_file_path) {
            console.log(`[REQUEST ID ${requestId}] textTo3D completed synchronously`);
            handleImmediateCompletion(res.output_file_path, res.output_filename);
            handlePostGeneration(res.output_file_path);
            console.log(`[REQUEST ID ${requestId}] GENERATION END - SUCCESS`);
            return;
          }

          // If backend returns job_id with processing status, subscribe to job stream
          if (res.status === 'processing' && res.job_id) {
            console.log(`[REQUEST ID ${requestId}] textTo3D started as background job: ${res.job_id}`);
            subscribeToJob(res.job_id, requestId);
            return;
          }

          console.warn(`[REQUEST ID ${requestId}] Unexpected response structure:`, res);
          throw new Error(`Unexpected response from text-to-3d API: ${JSON.stringify(res)}`);
        }
      }
      // =========================================================================
      // 2D WORKSPACE — routes through the Generation Agent
      // =========================================================================
      else {
        const s2d = store as typeof store2D;
        const params2d = {
          part_width_mm: s2d.width,
          part_height_mm: s2d.height,
          tool_diameter_mm: s2d.toolDiameter,
        };

        // Determine tool_type hint (LLM Agent on backend will inspect full intent and can override)
        let toolType: AgentChatRequest['tool_type'];
        const toolData: Record<string, any> = {
          ...params2d,
          user_id: user?.id,
          project_id: activeProjectId,
          prompt: userText,
        };

        if (hasImage) {
          toolType = 'image_to_2d';
          toolData.image_path = attachedFile!.file_path;
          toolData.prompt = userText || 'Vectorize and produce a CNC-ready DXF blueprint';
        } else if (activeFilePath && classifyText2DIntent(userText) === 'edit_2d') {
          toolType = 'edit_2d';
          toolData.dxf_path = activeFilePath;
          toolData.edit_prompt = userText;
        } else {
          toolType = 'text_to_2d';
          toolData.prompt = userText;
        }

        console.log(`[AGENT] Sending to agent — tool: ${toolType}`);
        const agentReq: AgentChatRequest = {
          session_id: agentSessionId.current,
          user_message: userText || `[${attachedFile?.filename}]`,
          tool_type: toolType,
          tool_data: toolData,
        };

        const agentRes = await agentService.chat(agentReq);
        console.log('[AGENT] Response:', agentRes);

        // ── Always show agent reply to user ───────────────────────────────────
        const agentMsg: ChatMessage = {
          id: `msg_agent_${Date.now()}`,
          sender: 'ai',
          text: agentRes.reply,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        };
        addMessage(agentMsg);

        // ── If clarification needed — stop here, user needs to reply ──────────
        if (agentRes.needs_clarification) {
          clearProgressTimer();
          store.setGenerating(false);
          isSendingRef.current = false;
          currentRequestIdRef.current = null;
          return;
        }

        // ── Tool errored ──────────────────────────────────────────────────────
        if (agentRes.tool_call?.error) {
          clearProgressTimer();
          store.setGenerating(false);
          isSendingRef.current = false;
          currentRequestIdRef.current = null;
          return;
        }

        // ── Tool succeeded → load output file ────────────────────────────────
        const result = agentRes.tool_call?.result;
        if (result) {
          const filePath: string | undefined = result.output_file_path;
          const fileName: string | undefined = result.output_filename;
          const dxfContent: string | undefined = result.dxf_content;

          if (dxfContent) {
            // Load inline DXF into the viewer
            loadDXFContent(dxfContent, fileName || 'generated.dxf');
            if (filePath && !is3D) {
              useWorkspaceStore.getState().loadFile(filePath, '2D');
            }
            if (filePath) store.setActiveFile(filePath);
            clearProgressTimer();
            store.setGenerating(false);
            isSendingRef.current = false;
            currentRequestIdRef.current = null;
            // ── Trigger save dialog so user can persist the file ──────────────
            // Pass both the server path (Electron can copy it) and the base64
            // content (fallback for browser/dev mode)
            handlePostGeneration(filePath, dxfContent);
          } else if (filePath) {
            handleImmediateCompletion(filePath, fileName);
            handlePostGeneration(filePath);
          }
        } else {
          clearProgressTimer();
          store.setGenerating(false);
          isSendingRef.current = false;
          currentRequestIdRef.current = null;
        }

        console.log(`[REQUEST ID ${requestId}] GENERATION END - via agent`);
        return;

        // ── Dead code kept for IDE type-checking only ─────────────────────────
        if (hasImage) {
          console.log(`[REQUEST ID ${requestId}] Workflow: IMAGE_TO_2D - image only`);
          console.log(`[REQUEST ID ${requestId}] → POST /generation/image-to-2d`);
          console.time(`[REQUEST ID ${requestId}] imageTo2D HTTP round-trip`);
          console.log(`[HTTP REQUEST ${requestId}] Sending to /generation/image-to-2d`, {
            user_id: user?.id,
            project_id: activeProjectId,
            image_path: attachedFile!.file_path,
            prompt: userText || 'Vectorize and produce a CNC-ready DXF blueprint',
            params: params2d
          });

          const res = await generationApiService.imageTo2D({
            user_id: user?.id,
            project_id: activeProjectId,
            image_path: attachedFile!.file_path,
            prompt: userText || 'Vectorize and produce a CNC-ready DXF blueprint',
            params: params2d
          });

          console.timeEnd(`[REQUEST ID ${requestId}] imageTo2D HTTP round-trip`);
          console.log(`[HTTP RESPONSE ${requestId}] Received from /generation/image-to-2d`, res);
          if (res.status === 'completed' && (res.output_file_path || res.dxf_content || res.dxf_url)) {
            console.log(`[REQUEST ID ${requestId}] imageTo2D completed synchronously`);
            if (res.dxf_content) {
              loadDXFContent(res.dxf_content, res.output_filename || 'generated.dxf');
              if (res.output_file_path) {
                store.setActiveFile(res.output_file_path);
              }
              clearProgressTimer();
              store.setGenerating(false);
              isSendingRef.current = false;
              currentRequestIdRef.current = null;
            } else if (res.output_file_path) {
              handleImmediateCompletion(res.output_file_path, res.output_filename);
            }
            const doneMsg: ChatMessage = {
              id: `msg_done_${Date.now()}`,
              sender: 'ai',
              text: `✨ 2D DXF blueprint successfully generated and loaded into workspace!\n\nYou can review and adjust dimensions from the control panel, then click **Export** to save your manufacturing file.`,
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };
            addMessage(doneMsg);
            handlePostGeneration(res.output_file_path);
            console.log(`[REQUEST ID ${requestId}] GENERATION END - SUCCESS`);
            return;
          }
          if (res.job_id && res.status !== 'completed') {
            console.log(`[REQUEST ID ${requestId}] Fallback to job streaming: ${res.job_id}`);
            subscribeToJob(res.job_id, requestId);
            return;
          }

          console.warn(`[REQUEST ID ${requestId}] Unexpected response structure:`, res);
        } else if (activeFilePath && userText && userText.trim()) {
          // EDIT workflow: existing DXF + edit prompt
          console.log(`[REQUEST ID ${requestId}] Workflow: EDIT_2D - existing DXF + edit prompt`);
          console.log(`[REQUEST ID ${requestId}] → POST /editing/ai`);
          console.log(`[HTTP REQUEST ${requestId}] Sending to /editing/ai`, {
            user_id: user?.id,
            project_id: activeProjectId,
            file_path: activeFilePath,
            prompt: userText,
            design_type: '2D',
          });

          const res = await apiClient.post('/editing/ai', {
            user_id: user?.id,
            project_id: activeProjectId,
            file_path: activeFilePath,
            prompt: userText,
            design_type: '2D',
          });

          console.log(`[HTTP RESPONSE ${requestId}] Received from /editing/ai`, res.data);
          if (res.data.output_file_path) {
            console.log(`[REQUEST ID ${requestId}] edit2D completed synchronously`);
            handleImmediateCompletion(res.data.output_file_path, res.data.output_filename);
            const doneMsg: ChatMessage = {
              id: `msg_done_${Date.now()}`,
              sender: 'ai',
              text: `✨ 2D DXF blueprint successfully edited!\n\n📄 **File:** \`${res.data.output_filename || 'edited.dxf'}\` (Click below to view in viewport)`,
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              attachments: [{
                id: `att_done_${Date.now()}`,
                filename: res.data.output_filename || 'edited.dxf',
                file_path: res.data.output_file_path,
                file_size: 0,
                format: 'DXF',
                upload_timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              }]
            };
            addMessage(doneMsg);
            handlePostGeneration(res.data.output_file_path);
            console.log(`[REQUEST ID ${requestId}] GENERATION END - SUCCESS`);
            return;
          }
        } else {
          // TEXT_TO_2D workflow: prompt only
          console.log(`[REQUEST ID ${requestId}] Workflow: TEXT_TO_2D - prompt only`);
          console.log(`[REQUEST ID ${requestId}] → POST /generation/text-to-2d`);
          console.time(`[REQUEST ID ${requestId}] textTo2D HTTP round-trip`);
          console.log(`[HTTP REQUEST ${requestId}] Sending to /generation/text-to-2d`, {
            user_id: user?.id,
            project_id: activeProjectId,
            prompt: userText,
            params: params2d
          });

          const res = await generationApiService.textTo2D({
            user_id: user?.id,
            project_id: activeProjectId,
            prompt: userText,
            params: params2d
          });

          console.timeEnd(`[REQUEST ID ${requestId}] textTo2D HTTP round-trip`);
          console.log(`[HTTP RESPONSE ${requestId}] Received from /generation/text-to-2d`, res);
          if (res.status === 'completed' && (res.output_file_path || res.dxf_content || res.dxf_url)) {
            console.log(`[REQUEST ID ${requestId}] textTo2D completed synchronously`);
            if (res.dxf_content) {
              loadDXFContent(res.dxf_content, res.output_filename || 'generated.dxf');
              if (res.output_file_path) {
                store.setActiveFile(res.output_file_path);
              }
              clearProgressTimer();
              store.setGenerating(false);
              isSendingRef.current = false;
              currentRequestIdRef.current = null;
            } else if (res.output_file_path) {
              handleImmediateCompletion(res.output_file_path, res.output_filename);
            }
            const doneMsg: ChatMessage = {
              id: `msg_done_${Date.now()}`,
              sender: 'ai',
              text: `✨ 2D DXF blueprint successfully generated!\n\n📄 **File:** \`${res.output_filename || 'generated.dxf'}\` (Click below to view in viewport)`,
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              attachments: res.output_file_path ? [{
                id: `att_done_${Date.now()}`,
                filename: res.output_filename || 'generated.dxf',
                file_path: res.output_file_path,
                file_size: 0,
                format: 'DXF',
                upload_timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              }] : undefined
            };
            addMessage(doneMsg);
            handlePostGeneration(res.output_file_path);
            console.log(`[REQUEST ID ${requestId}] GENERATION END - SUCCESS`);
            return;
          }
          if (res.job_id && res.status !== 'completed') {
            console.log(`[REQUEST ID ${requestId}] Fallback to job streaming: ${res.job_id}`);
            subscribeToJob(res.job_id, requestId);
            return;
          }

          console.warn(`[REQUEST ID ${requestId}] Unexpected response structure:`, res);
        }
      }
    } catch (err: any) {
      console.error(`[REQUEST ID ${requestId}] GENERATION ERROR:`, err);
      console.error(`[REQUEST ID ${requestId}] Error details:`, {
        status: err?.response?.status,
        code: err?.code,
        message: err?.message,
        data: err?.response?.data
      });

      clearProgressTimer();
      store.setGenerating(false);
      isSendingRef.current = false;
      currentRequestIdRef.current = null;

      const status = err?.response?.status || err?.statusCode;
      const rawDetail = (err?.response?.data?.detail || err?.response?.data?.error || err?.userMessage || err?.message || '').toString();
      const lower = rawDetail.toLowerCase();

      let displayError: string;

      if (
        err?.code === 'ECONNABORTED' ||
        lower.includes('timeout') ||
        lower.includes('timed out') ||
        err?.name === 'TimeoutError'
      ) {
        displayError = '⏳ Generation took longer than expected (> 3 minutes). The server may be under high load or processing in queue; please retry.';
      } else if (
        err?.code === 'ERR_NETWORK' ||
        lower.includes('network error') ||
        lower.includes('failed to fetch') ||
        lower.includes('econnrefused')
      ) {
        displayError = '📡 Unable to connect to the generation server. Please check your network connection and API endpoint configuration in backend.';
      } else if (
        status === 429 &&
        (lower.includes('limit') || lower.includes('plan_limit_reached') || lower.includes('upgrade') || err?.response?.data?.detail?.code === 'PLAN_LIMIT_REACHED')
      ) {
        const detailMsg = err?.response?.data?.detail?.message || err?.response?.data?.detail;
        displayError = typeof detailMsg === 'string'
          ? `⚠️ ${detailMsg}\n\n👉 Go to **Settings → Billing & Subscription** to upgrade your plan.`
          : `⚠️ You have reached your monthly generation limit. Please navigate to **Settings → Billing & Subscription** to upgrade your plan.`;
      } else if (status === 429 || err?.code === 'BUSY_429' || lower.includes('busy') || lower.includes('429')) {
        displayError = '⏳ Generation server is currently busy with another job. Please wait a moment and try again.';

      } else if (status === 503 || err?.code === 'MODULE_ERROR_503' || lower.includes('503') || lower.includes('unavailable')) {
        displayError = '⚠️ Generation service is currently unavailable. Please verify that the AI service endpoint is running.';
      } else if (lower.includes('zerogpu') || lower.includes('quota') || lower.includes('upstream gradio')) {
        displayError = '⚠️ تم استنفاد الحصة المجانية لكارت الشاشة (Hugging Face ZeroGPU Quota) على السيرفر البعيد. يرجى الانتظار حتى إعادة التعيين اليومي أو استخدام حساب Pro.';
      } else if (status === 413 || err?.code === 'FILE_TOO_LARGE_413' || lower.includes('50mb') || lower.includes('too large')) {
        displayError = '📁 Uploaded file size exceeds the 50 MB limit. Please select a smaller file.';
      } else if (status === 400 || lower.includes('invalid') || lower.includes('required')) {
        displayError = '⚠️ Invalid inputs or missing dimensions. Please review your prompt and dimension settings, then try again.';
      } else if (status === 401 || status === 403) {
        displayError = '🔒 Session expired or unauthorized action. Please log in again.';
      } else if (rawDetail && rawDetail.trim()) {
        const cleanDetail = rawDetail.replace(/^Internal Engineering Backend Error:\s*/i, '').trim();
        displayError = cleanDetail.startsWith('❌') || cleanDetail.startsWith('⚠️') ? cleanDetail : `❌ ${cleanDetail}`;
      } else {
        displayError = '❌ An unexpected error occurred while processing your request. Please try again.';
      }

      const failMsg: ChatMessage = {
        id: `msg_err_${Date.now()}`,
        sender: 'ai',
        text: displayError,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      addMessage(failMsg);
      console.log(`[REQUEST ID ${requestId}] GENERATION END - FAILED`);
    } finally {
      // Ensure cleanup happens regardless of success or failure
      console.log(`[REQUEST ID ${requestId}] GENERATION END - CLEANUP`);
      clearProgressTimer();
      isSendingRef.current = false;
      currentRequestIdRef.current = null;
    }
  };

  const handleReset = () => {
    eventSourceRef.current?.close();
    store.resetWorkspace();
  };

  const handleRegenerate = () => {
    const last = [...chatMessages].reverse().find(m => m.sender === 'user');
    if (last?.text) setInputPrompt(last.text);
  };

  const progressColor = store.generatingStage === 'failed' ? 'bg-rose-500'
    : store.generatingProgress === 100 ? 'bg-emerald-500'
      : 'bg-indigo-500';

  return (
    <aside className="w-72 lg:w-80 bg-white border-r border-slate-200/90 flex flex-col justify-between p-3 lg:p-4 select-none font-sans z-30 shrink-0">

      {/* Header */}
      <div className="space-y-3 pb-3 border-b border-slate-100">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${is3D ? 'bg-indigo-50 text-indigo-600' : 'bg-emerald-50 text-emerald-600'} ml-2`}>
              {is3D ? <Box className="w-4 h-4" /> : <FileCode className="w-4 h-4" />}
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900">
                {is3D ? '3D AI CAD Studio' : '2D DXF Blueprint'}
              </h2>
              <p className="text-[10px] font-mono text-slate-400">
                {is3D ? 'Output: STL | L × W × H' : 'Output: DXF | W(X) × H(Y)'}
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-1">
            <button onClick={handleRegenerate} title="Re-use last prompt"
              className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors">
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
            <button onClick={handleReset} title="Clear & reset workspace"
              className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            {store.activeFilePath && (
              <button onClick={() => setExportModalOpen(true)}
                title={`Export ${is3D ? 'STL' : 'DXF'}`}
                className="p-1.5 rounded-lg text-indigo-600 bg-indigo-50 hover:bg-indigo-100 transition-colors">
                <Download className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Chat Messages */}
      <div className="flex-1 overflow-y-auto py-3 space-y-3 min-h-0">
        {chatMessages.map((msg) => (
          <div key={msg.id} className={`flex flex-col space-y-1 ${msg.sender === 'user' ? 'items-end' : 'items-start'} w-full`}>
            <div className={`p-3.5 rounded-2xl text-xs leading-relaxed max-w-[95%] overflow-hidden break-words shadow-xs ${msg.sender === 'user'
              ? 'bg-blue-600 text-white rounded-br-none font-medium'
              : 'bg-slate-50 border border-slate-200 text-slate-800 rounded-bl-none'
              }`}>
              {msg.sender === 'user' ? (
                <div className="whitespace-pre-wrap">{msg.text}</div>
              ) : (
                <div className="prose prose-xs max-w-none text-slate-800 leading-relaxed font-sans [&>p]:mb-1.5 [&>p:last-child]:mb-0 [&>ul]:list-disc [&>ul]:pl-5 [&>ol]:list-decimal [&>ol]:pl-5 [&>li]:mb-0.5 [&>h1]:font-bold [&>h1]:text-sm [&>h2]:font-bold [&>h2]:text-xs [&>h3]:font-bold [&>strong]:font-semibold [&>strong]:text-slate-900">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
                </div>
              )}

              {msg.attachments && msg.attachments.length > 0 && (
                <div className="mt-2 pt-2 border-t border-slate-200 space-y-1.5">
                  {msg.attachments.map((att) => {
                    const isImg = isImageFile(att.filename);
                    const imgUrl = isImg ? getStaticFileUrl(att.file_path) : null;
                    return (
                      <div key={att.id} className="flex flex-col space-y-1">
                        {isImg && imgUrl && (
                          <div onClick={() => setPreviewImageUrl(imgUrl)}
                            className="relative group cursor-pointer overflow-hidden rounded-xl border border-white/30 max-w-[200px]">
                            <img src={imgUrl} alt={att.filename} className="w-full h-24 object-cover group-hover:scale-105 transition-transform duration-300" />
                            <div className="absolute inset-0 bg-slate-900/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white space-x-1">
                              <Eye className="w-4 h-4" />
                            </div>
                          </div>
                        )}
                        <div 
                          onClick={() => {
                            if (att.file_path) {
                              console.log("[Chat] Loading selected attachment into viewport:", att.file_path);
                              useWorkspaceStore.getState().loadFile(att.file_path, is3D ? '3D' : '2D', activeProjectId ?? undefined, activeProjectName ?? undefined);
                            }
                          }}
                          title="Click to load into Viewport"
                          className="text-[11px] font-mono flex items-center justify-between p-2 rounded-xl bg-slate-100 hover:bg-indigo-50 text-slate-800 hover:text-indigo-700 border border-slate-200/90 hover:border-indigo-300 cursor-pointer transition-all active:scale-[0.98] group shadow-xs"
                        >
                          <div className="flex items-center space-x-1.5 truncate">
                            <Paperclip className="w-3.5 h-3.5 shrink-0 text-indigo-600 ml-1" />
                            <span className="truncate font-semibold">{att.filename}</span>
                          </div>
                          <span className="text-[10px] bg-indigo-100 group-hover:bg-indigo-600 text-indigo-700 group-hover:text-white px-2 py-0.5 rounded-md font-sans font-semibold transition-colors shrink-0 ml-1">
                            Load in Viewport
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            {/* Bug #5 — Add / Replace buttons, shown below the decision message */}
            {pendingPartDecision && msg.id === pendingPartDecision.decisionMsgId && (
              <div className="flex gap-2 mt-1 ml-1">
                <button
                  id={`btn-add-part-${msg.id}`}
                  onClick={() => {
                    const d = pendingPartDecision;
                    setPendingPartDecision(null);
                    finalisePart(d.filePath, d.fileName, d.partName, 'add');
                    addMessage({
                      id: `msg_done_${Date.now()}`,
                      sender: 'ai',
                      text: `✨ **${d.partName}** added as a new part in the Model Tree. You now have ${(store as typeof store3D).parts.length + 1} part(s) in your workspace.`,
                      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    });
                  }}
                  className="flex-1 text-[10px] font-semibold px-2.5 py-1.5 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 active:scale-95 transition-all"
                >
                  + Add as New Part
                </button>
                <button
                  id={`btn-replace-part-${msg.id}`}
                  onClick={() => {
                    const d = pendingPartDecision;
                    setPendingPartDecision(null);
                    finalisePart(d.filePath, d.fileName, d.partName, 'replace');
                    addMessage({
                      id: `msg_done_${Date.now()}`,
                      sender: 'ai',
                      text: `🔄 Workspace replaced with **${d.partName}**. Previous parts have been removed.`,
                      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    });
                  }}
                  className="flex-1 text-[10px] font-semibold px-2.5 py-1.5 rounded-xl bg-slate-100 text-slate-700 hover:bg-rose-50 hover:text-rose-700 border border-slate-200 active:scale-95 transition-all"
                >
                  ↺ Replace Existing
                </button>
              </div>
            )}
            {msg.timestamp && (
              <span className="text-[9px] text-slate-400 font-mono px-1">{msg.timestamp}</span>
            )}
          </div>
        ))}


        {/* Live Generation Progress */}
        {isGenerating && (
          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3 space-y-2 rounded-bl-none">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center space-x-1.5 text-slate-700 font-semibold">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-600 ml-1" />
                <span>{store.generatingStage
                  ? store.generatingStage.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                  : 'Generating…'
                }</span>
              </div>
              {store.generatingProgress > 0 && (
                <span className="font-mono text-slate-500 font-bold">{store.generatingProgress}%</span>
              )}
            </div>
            <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${store.generatingProgress > 0 ? progressColor : 'bg-indigo-500 animate-pulse w-full'
                  }`}
                style={store.generatingProgress > 0 ? { width: `${Math.max(store.generatingProgress, 5)}%` } : undefined}
              />
            </div>
            <p className="text-[10px] text-slate-500 font-mono leading-tight">
              {store.generatingMessage || (is3D ? 'Waiting for 3D API generation…' : 'Generating, please wait...')}
            </p>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* File Rejection Banner */}
      {fileValidationError && (
        <div className="mb-2 p-2.5 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-[11px] flex items-start space-x-2">
          <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5 ml-1" />
          <div className="flex-1 min-w-0">
            <span className="font-bold block">Format Rejected</span>
            <span className="text-[10px] leading-tight block text-rose-600">{fileValidationError}</span>
          </div>
          <button onClick={() => setFileValidationError(null)} className="text-rose-400 hover:text-rose-700">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Pending Attachments */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 pb-2">
          {attachments.map((att) => {
            const isImg = isImageFile(att.filename);
            const imgUrl = isImg ? getStaticFileUrl(att.file_path) : null;
            return (
              <div key={att.id}
                className="relative group bg-indigo-50 border border-indigo-200 text-indigo-800 p-1.5 rounded-xl text-[10px] font-mono flex items-center space-x-2 shadow-xs">
                {isImg && imgUrl ? (
                  <div onClick={() => setPreviewImageUrl(imgUrl)}
                    className="relative w-8 h-8 rounded-lg overflow-hidden shrink-0 border border-indigo-300 cursor-pointer">
                    <img src={imgUrl} alt={att.filename} className="w-full h-full object-cover" />
                  </div>
                ) : (
                  <Paperclip className="w-3.5 h-3.5 text-indigo-500 shrink-0 ml-1" />
                )}
                <span className="truncate max-w-[100px] font-semibold">{att.filename}</span>
                <button onClick={() => store.removeAttachment(att.id)}
                  className="p-1 rounded-md text-indigo-400 hover:text-rose-600 hover:bg-rose-50 transition-colors">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept={acceptAttribute} className="hidden" />
      {/* Hidden directory picker for project folder selection */}
      <input
        type="file"
        ref={folderInputRef}
        onChange={handleFolderSelect}
        // @ts-ignore – webkitdirectory is non-standard but widely supported
        webkitdirectory="true"
        directory="true"
        multiple
        className="hidden"
      />

      {/* Prompt Card */}
      <div className="bg-white border border-slate-200 rounded-2xl p-3 shadow-xs space-y-2">
        <textarea
          rows={3}
          placeholder={isGenerating ? 'Generating… please wait' : `Describe ${is3D ? '3D STL' : '2D DXF'} design…`}
          value={inputPrompt}
          onChange={(e) => setInputPrompt(e.target.value)}
          disabled={isGenerating}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); }
          }}
          className="w-full bg-transparent text-xs text-slate-900 placeholder:text-slate-400 outline-none resize-none disabled:opacity-50 disabled:cursor-not-allowed"
        />
        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center space-x-1.5">
            <button type="button" onClick={() => fileInputRef.current?.click()}
              disabled={isGenerating || isUploading}
              className="px-2.5 py-1.5 rounded-xl bg-indigo-50 hover:bg-indigo-600 text-indigo-700 hover:text-white transition-all border border-indigo-200/80 flex items-center space-x-1.5 disabled:opacity-40 font-bold shadow-xs cursor-pointer">
              {isUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4 stroke-[3] ml-1" />}
              <span className="text-[11px]">{is3D ? 'Upload STL / Image' : 'Upload DXF / Image'}</span>
            </button>

            <div className="relative">
              <button type="button" onClick={() => {
                if (activeProjectName) {
                  setIsFolderPopoverOpen(!isFolderPopoverOpen);
                } else {
                  folderInputRef.current?.click();
                }
              }}
                disabled={isGenerating}
                className={`p-1.5 rounded-xl border flex items-center space-x-1 disabled:opacity-40 font-bold shadow-xs cursor-pointer transition-all ${activeProjectName
                  ? 'bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100'
                  : 'bg-slate-100 hover:bg-amber-500 text-slate-600 hover:text-white border-slate-200/80'
                  }`}
                title={activeProjectName ? `Click to view DXF files in '${activeProjectName}'` : 'Select Project Folder from your computer'}>
                <Folder className="w-4 h-4 text-amber-500 shrink-0" />
                <span className="text-[11px] px-1 max-w-[110px] truncate">{activeProjectName || 'Project Folder'}</span>
              </button>

              {/* Folder DXF Files Popover */}
              {isFolderPopoverOpen && activeProjectName && (
                <div className="absolute bottom-full mb-2 left-0 w-72 bg-white rounded-2xl shadow-2xl border border-slate-200 p-3 z-50 animate-in fade-in slide-in-from-bottom-2 duration-150">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                    <div className="flex items-center space-x-1.5 overflow-hidden">
                      <Folder className="w-4 h-4 text-amber-500 shrink-0" />
                      <span className="text-xs font-bold text-slate-900 truncate">{activeProjectName}</span>
                    </div>
                    <button onClick={() => setIsFolderPopoverOpen(false)} className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="py-2 space-y-1 max-h-56 overflow-y-auto">
                    <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider px-1 pb-1">
                      {is3D ? '3D / DXF Models' : 'DXF Blueprints in Folder'} ({folderFiles.length})
                    </div>

                    {folderFiles.length === 0 ? (
                      <div className="py-4 text-center text-slate-400 text-xs">
                        No DXF files found in this folder.
                      </div>
                    ) : (
                      folderFiles
                        .map((att) => {
                          const isActive = store.activeFilePath === att.file_path;
                          return (
                            <button
                              key={att.id}
                              onClick={() => {
                                console.log(`[FolderBrowser] Loading selected DXF onto viewport: ${att.filename} (${att.file_path})`);
                                useWorkspaceStore.getState().loadFile(att.file_path, is3D ? '3D' : '2D');
                                store.setActiveFile(att.file_path);
                                setIsFolderPopoverOpen(false);
                              }}
                              className={`w-full text-left px-2.5 py-2 rounded-xl text-xs flex items-center justify-between group transition-all ${isActive
                                ? 'bg-indigo-50 text-indigo-700 font-semibold border border-indigo-200'
                                : 'hover:bg-slate-50 text-slate-700 border border-transparent'
                                }`}
                            >
                              <div className="flex items-center space-x-2 truncate">
                                <FileCode className={`w-4 h-4 shrink-0 ${isActive ? 'text-indigo-600' : 'text-slate-400 group-hover:text-indigo-500'}`} />
                                <span className="truncate">{att.filename}</span>
                              </div>
                              {isActive ? (
                                <span className="text-[9px] font-mono bg-indigo-600 text-white px-1.5 py-0.5 rounded-full shrink-0">
                                  Active
                                </span>
                              ) : (
                                <Eye className="w-3.5 h-3.5 text-slate-300 group-hover:text-indigo-600 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                              )}
                            </button>
                          );
                        })
                    )}
                  </div>

                  <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
                    <button
                      onClick={() => {
                        setIsFolderPopoverOpen(false);
                        folderInputRef.current?.click();
                      }}
                      className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 flex items-center space-x-1 py-1 px-2 rounded-lg hover:bg-indigo-50 transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Change Folder</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <button onClick={handleSendMessage}
            disabled={isGenerating || isUploading || (!inputPrompt.trim() && attachments.length === 0) || !is2DInputsValid}
            className="w-8 h-8 rounded-full bg-blue-600 hover:bg-blue-700 text-white flex items-center justify-center shadow-md transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            title={!is2DInputsValid ? 'Please set valid Width, Height, and Tool Diameter values (all must be > 0)' : 'Send message'}>
            {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Image Lightbox */}
      {previewImageUrl && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4"
          onClick={() => setPreviewImageUrl(null)}>
          <div className="relative max-w-4xl max-h-[90vh] bg-white rounded-3xl overflow-hidden shadow-2xl p-2 border border-slate-200"
            onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setPreviewImageUrl(null)}
              className="absolute top-4 right-4 p-2 bg-slate-900/80 text-white hover:bg-slate-900 rounded-full z-10">
              <X className="w-5 h-5" />
            </button>
            <img src={previewImageUrl} alt="Preview" className="max-w-full max-h-[82vh] object-contain rounded-2xl" />
          </div>
        </div>
      )}

      {/* Save / Name Project Modal */}
      <SaveProjectModal
        isOpen={isSaveModalOpen}
        onClose={() => setIsSaveModalOpen(false)}
        defaultType={is3D ? '3D' : '2D'}
        filePath={pendingSaveFilePath}
        onSaved={handleProjectSaved}
      />
    </aside>
  );
};
