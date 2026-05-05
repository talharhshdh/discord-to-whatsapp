/**
 * @file session-manager.ts
 * @description Centralized session manager for all running services.
 * Tracks browsers, terminals, VSCode, Android emulator, etc.
 */

import { ChildProcess } from 'child_process';

export interface Session {
  id: string;
  type: 'browser' | 'terminal' | 'vscode' | 'android' | 'custom-browser';
  url: string;
  username?: string;
  password?: string;
  startedAt: Date;
  metadata?: {
    port?: number;
    containerName?: string;
    targetUrl?: string; // For custom-browser
    tunnelProcess?: ChildProcess;
  };
}

class SessionManager {
  private sessions: Map<string, Session> = new Map();

  /**
   * Add a new session
   */
  addSession(session: Session): void {
    this.sessions.set(session.id, session);
    console.log(`📊 Session added: ${session.type} (${session.id})`);
  }

  /**
   * Get a session by ID
   */
  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /**
   * Get all sessions
   */
  getAllSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get sessions by type
   */
  getSessionsByType(type: Session['type']): Session[] {
    return Array.from(this.sessions.values()).filter(s => s.type === type);
  }

  /**
   * Remove a session
   */
  removeSession(id: string): boolean {
    const removed = this.sessions.delete(id);
    if (removed) {
      console.log(`📊 Session removed: ${id}`);
    }
    return removed;
  }

  /**
   * Update session URL (e.g., when tunnel URL changes)
   */
  updateSessionUrl(id: string, url: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.url = url;
    }
  }

  /**
   * Check if a session exists
   */
  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  /**
   * Get session count
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Clear all sessions
   */
  clearAll(): void {
    this.sessions.clear();
    console.log('📊 All sessions cleared');
  }
}

// Singleton instance
export const sessionManager = new SessionManager();
