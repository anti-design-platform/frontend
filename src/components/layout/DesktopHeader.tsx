import React, { useState, useEffect, useRef } from 'react';
import {
  ChevronLeft, Undo2, Redo2, Download, Edit2, Check, X, ExternalLink
} from 'lucide-react';
import { useWorkspaceStore } from '../../app/store/useWorkspaceStore';
import { useSettingsStore } from '../../app/store/useSettingsStore';
import { useAuthStore } from '../../app/store/useAuthStore';
import { use2DWorkspaceStore } from '../../app/store/use2DWorkspaceStore';
import { use3DWorkspaceStore } from '../../app/store/use3DWorkspaceStore';
import { BrandLogo } from '../common/BrandLogo';
import { projectsApiService } from '../../services/api/projects';

export const DesktopHeader: React.FC = () => {
  const { setViewMode, setExportModalOpen, viewMode, activeProjectId, activeProjectName, setActiveProjectId } = useWorkspaceStore();
  const { user } = useAuthStore();
  const store2D = use2DWorkspaceStore();
  const store3D = use3DWorkspaceStore();

  const is3D = viewMode === 'workspace_3d';
  const store = is3D ? store3D : store2D;
  const userName = user?.name || 'Engineer';

  const isDirty = store.isDirty;
  const canUndo = store.canUndo ? store.canUndo() : false;
  const canRedo = store.canRedo ? store.canRedo() : false;

  // Project name and inline editing state
  const defaultProjectName = is3D ? 'Untitled 3D Project' : 'Untitled 2D Drawing';
  const currentDisplayName = activeProjectName || defaultProjectName;
  
  const [isEditingName, setIsEditingName] = useState<boolean>(false);
  const [editedName, setEditedName] = useState<string>(currentDisplayName);
  const [isSavingName, setIsSavingName] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setEditedName(activeProjectName || defaultProjectName);
  }, [activeProjectName, defaultProjectName]);

  useEffect(() => {
    if (isEditingName && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditingName]);

  const handleStartEditing = () => {
    setEditedName(currentDisplayName);
    setIsEditingName(true);
  };

  const handleSaveName = async () => {
    const trimmed = editedName.trim();
    if (!trimmed) {
      setIsEditingName(false);
      setEditedName(currentDisplayName);
      return;
    }

    setIsSavingName(true);
    try {
      if (activeProjectId) {
        // Save to SQLite via PATCH /projects/:id
        await projectsApiService.updateProject(activeProjectId, { name: trimmed });
      }
      setActiveProjectId(activeProjectId, trimmed);
      setIsEditingName(false);
    } catch (err) {
      console.error('Failed to update project name:', err);
      // Fallback local update
      setActiveProjectId(activeProjectId, trimmed);
      setIsEditingName(false);
    } finally {
      setIsSavingName(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSaveName();
    } else if (e.key === 'Escape') {
      setIsEditingName(false);
      setEditedName(currentDisplayName);
    }
  };

  const handleSave = async () => {
    const wsStore = useWorkspaceStore.getState();
    const s2d = use2DWorkspaceStore.getState();
    const s3d = use3DWorkspaceStore.getState();

    // 1. Resolve activeFilePath across all stores and parts
    let activeFilePath =
      store.activeFilePath ||
      wsStore.activeFilePath ||
      (is3D ? s3d.activeFilePath : s2d.activeFilePath);

    if (!activeFilePath && is3D && s3d.parts && s3d.parts.length > 0) {
      const realPart = s3d.parts.find((p) => p.filePath);
      if (realPart) {
        activeFilePath = realPart.filePath;
      }
    }

    // 2. Resolve DXF content or raw entities
    const dxfContent = wsStore.dxfContent;

    // Check if electron native save is available
    const api = (window as any).electronAPI;
    if (api?.saveGeneratedFile) {
      const defaultName =
        activeFilePath?.split(/[/\\]/).pop() ||
        wsStore.activeFileName ||
        (is3D ? 'model.stl' : 'blueprint.dxf');

      try {
        const res = await api.saveGeneratedFile({
          sourcePath: activeFilePath || null,
          base64Data: dxfContent || null,
          textData: dxfContent || null,
          defaultName
        });
        if (res?.saved) {
          alert(`✅ Successfully saved to: ${res.destPath}`);
          if (res.destPath) {
            useWorkspaceStore.getState().setActiveFilePath(res.destPath);
            if (is3D) s3d.setActiveFile(res.destPath);
            else s2d.setActiveFile(res.destPath);
          }
          if (store.saveWorkspace) await store.saveWorkspace();
          return;
        } else if (res?.error) {
          alert(`❌ Failed to save file: ${res.error}`);
          return;
        }
        // User cancelled dialog
        return;
      } catch (err: any) {
        console.error('Error saving via Electron IPC:', err);
      }
    }

    // Fallback: Trigger export dialog
    setExportModalOpen(true);
  };

  const handleUndo = () => {
    if (store.undo) {
      store.undo();
    }
  };

  const handleRedo = () => {
    if (store.redo) {
      store.redo();
    }
  };

  const handleExportClick = () => {
    const valid = store.validateInputs();
    if (!valid) {
      alert('⚠️ Export failed: please fix invalid dimensions in the Properties panel first.');
      return;
    }
    setExportModalOpen(true);
  };

  const handleOpenCad = async () => {
    const wsStore = useWorkspaceStore.getState();
    const s2d = use2DWorkspaceStore.getState();
    const s3d = use3DWorkspaceStore.getState();

    let activeFilePath =
      store.activeFilePath ||
      wsStore.activeFilePath ||
      (is3D ? s3d.activeFilePath : s2d.activeFilePath);

    if (!activeFilePath && is3D && s3d.parts && s3d.parts.length > 0) {
      const realPart = s3d.parts.find((p) => p.filePath);
      if (realPart) {
        activeFilePath = realPart.filePath;
      }
    }

    if (!activeFilePath) {
      alert('⚠️ No active CAD file is loaded in the workspace yet. Please generate or import a file first.');
      return;
    }

    const { cadExecutablePath } = useSettingsStore.getState();
    const api = (window as any).electronAPI || (window as any).electron;
    if (api?.openExternalCad) {
      const res = await api.openExternalCad(cadExecutablePath, activeFilePath);
      if (!res.success) {
        alert(`❌ Failed to open CAD application: ${res.error}`);
      } else if (res.localPath && res.localPath !== activeFilePath) {
        // Update store with the downloaded local path so future saves/opens use it
        useWorkspaceStore.getState().setActiveFilePath(res.localPath);
        if (is3D) s3d.setActiveFile(res.localPath);
        else s2d.setActiveFile(res.localPath);
      }
    } else {
      alert('⚠️ Opening CAD application is only supported in the Desktop Electron application.');
    }
  };

  return (
    <header className="h-12 bg-white border-b border-slate-200/90 flex items-center justify-between px-4 select-none z-50 font-sans">
      
      {/* Left: Brand + Back + Project Title (Inline Editable) */}
      <div className="flex items-center space-x-3 text-xs">
        <div 
          onClick={() => setViewMode('home')}
          className="flex items-center space-x-2 cursor-pointer group ml-2"
        >
          <BrandLogo size="md" />
        </div>

        <button 
          onClick={() => setViewMode('home')}
          className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          title="Back to Home"
        >
          <ChevronLeft className="w-4 h-4 rotate-180" />
        </button>

        <div className="flex items-center space-x-2 font-medium mr-2">
          <span className={`px-2 py-0.5 rounded-md text-[10px] font-black tracking-wider ${
            is3D ? 'bg-indigo-50 text-indigo-700' : 'bg-emerald-50 text-emerald-700'
          }`}>
            {is3D ? '3D Workspace' : '2D Workspace'}
          </span>

          {/* Project Name (Inline Editable) */}
          {isEditingName ? (
            <div className="flex items-center space-x-1 bg-slate-100 rounded-lg px-1 py-0.5 border border-indigo-300">
              <input
                ref={inputRef}
                type="text"
                value={editedName}
                onChange={(e) => setEditedName(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleSaveName}
                disabled={isSavingName}
                className="bg-transparent font-bold text-slate-900 text-xs px-1.5 py-0.5 outline-none w-44 sm:w-60"
                maxLength={60}
              />
              <button
                onMouseDown={(e) => { e.preventDefault(); handleSaveName(); }}
                className="p-0.5 text-emerald-600 hover:text-emerald-700 rounded hover:bg-emerald-50"
                title="Save Project Name"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
              <button
                onMouseDown={(e) => { e.preventDefault(); setIsEditingName(false); setEditedName(currentDisplayName); }}
                className="p-0.5 text-slate-400 hover:text-rose-600 rounded hover:bg-rose-50"
                title="Cancel"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <div
              onClick={handleStartEditing}
              className="flex items-center space-x-1.5 px-2 py-1 rounded-lg hover:bg-slate-100 cursor-pointer group transition-colors"
              title="Click to rename project"
            >
              <span className="text-slate-900 font-bold truncate max-w-[140px] sm:max-w-[220px] md:max-w-xs text-xs">
                {currentDisplayName}
              </span>
              <Edit2 className="w-3 h-3 text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          )}
          
          {/* Saved / Unsaved Dynamic Indicator */}
          {isDirty ? (
            <div className="flex items-center space-x-1.5 bg-amber-50 px-2 py-0.5 rounded-md border border-amber-200">
              <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse ml-1" />
              <span className="text-[11px] font-bold text-amber-700">Unsaved changes</span>
            </div>
          ) : (
            <div className="flex items-center space-x-1.5 bg-slate-50 px-2 py-0.5 rounded-md border border-slate-200/60">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 ml-1" />
              <span className="text-[11px] font-semibold text-slate-500">Saved</span>
            </div>
          )}
        </div>
      </div>

      {/* Right Tools */}
      <div className="flex items-center space-x-3 text-xs">
        {/* Undo / Redo */}
        <div className="flex items-center space-x-1 text-slate-400">
          <button 
            onClick={handleUndo}
            disabled={!canUndo}
            className={`p-1.5 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors ${!canUndo ? 'opacity-30 cursor-not-allowed' : ''}`} 
            title="Undo (Ctrl+Z)"
            data-testid="undo-button"
          >
            <Undo2 className="w-4 h-4" />
          </button>
          <button 
            onClick={handleRedo}
            disabled={!canRedo}
            className={`p-1.5 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors ${!canRedo ? 'opacity-30 cursor-not-allowed' : ''}`} 
            title="Redo (Ctrl+Y)"
            data-testid="redo-button"
          >
            <Redo2 className="w-4 h-4" />
          </button>
        </div>

        <div className="h-4 w-px bg-slate-200 mx-2" />

        {/* Save Button */}
        <button
          onClick={handleSave}
          title={isDirty ? 'Click to save changes' : 'All changes saved'}
          className={`px-3.5 py-1.5 rounded-lg transition-all font-bold ${
            isDirty
              ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-md cursor-pointer ring-2 ring-blue-300 ring-offset-1'
              : 'bg-slate-100 text-slate-400 hover:bg-slate-200 cursor-default'
          }`}
        >
          {isDirty ? 'Save *' : 'Save'}
        </button>

        {/* Open CAD Button */}
        <button
          onClick={handleOpenCad}
          className="flex items-center space-x-1.5 px-3 py-1.5 font-bold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200/80 rounded-lg transition-colors shadow-xs"
          title="Open current design in local CAD software"
        >
          <ExternalLink className="w-3.5 h-3.5 ml-1 text-indigo-600" />
          <span>Open CAD</span>
        </button>

        {/* Export */}
        <button
          onClick={handleExportClick}
          className="flex items-center space-x-1.5 px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors"
        >
          <Download className="w-3.5 h-3.5 ml-1" />
          <span>Export</span>
        </button>

        {/* User Avatar */}
        <div className="w-7 h-7 rounded-full bg-indigo-600 text-white font-bold flex items-center justify-center text-xs shadow-sm mr-2">
          {userName.charAt(0).toUpperCase()}
        </div>
      </div>

    </header>
  );
};
