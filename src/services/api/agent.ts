/**
 * services/api/agent.ts
 * ─────────────────────
 * Thin client for the Generation Agent API.
 * POST /api/v1/agent/chat
 */
import { apiClient } from './client';

export interface AgentChatRequest {
  session_id: string;       // stable per browser session / project
  user_message: string;
  tool_type:
    | 'text_to_2d' | 'image_to_2d'
    | 'text_to_3d' | 'image_to_3d'
    | 'edit_2d'   | 'edit_3d';
  tool_data: Record<string, any>;
}

export interface AgentToolCallResult {
  tool: string;
  params: Record<string, any>;
  result?: Record<string, any>;
  error?: string;
}

export interface AgentChatResponse {
  reply: string;
  needs_clarification: boolean;
  missing_fields: string[];
  tool_call: AgentToolCallResult | null;
}

export const agentService = {
  /**
   * Send a message to the agent and get back its reply + optional tool result.
   */
  chat: async (req: AgentChatRequest): Promise<AgentChatResponse> => {
    const res = await apiClient.post<AgentChatResponse>('/agent/chat', req);
    return res.data;
  },

  /**
   * Clear agent memory for the given session (e.g. on project switch).
   */
  clearMemory: async (sessionId: string): Promise<void> => {
    await apiClient.delete(`/agent/memory/${sessionId}`);
  },
};
