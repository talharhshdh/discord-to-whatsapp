/**
 * @file session-manager.ts
 * @description Centralized session manager for all running services.
 * Tracks browsers, terminals, VSCode, Android emulator, etc.
 */

import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

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
    cloudflaredUrl?: string; // Store cloudflared tunnel URL
  };
}

// Serializable version of Session (excludes ChildProcess)
interface SerializableSession extends Omit<Session, 'metadata'> {
  metadata?: Omit<Session['metadata'], 'tunnelProcess'>;
}

const SESSIONS_FILE = path.join(process.cwd(), 'auth_info', 'sessions.json');

class SessionManager {
  private sessions: Map<string, Session> = new Map();

  constructor() {
    this.loadSessions();
  }

  /**
   * Load sessions from disk on startup
   */
  private loadSessions(): void {
    try {
      if (fs.existsSync(SESSIONS_FILE)) {
        const data = fs.readFileSync(SESSIONS_FILE, 'utf-8');
        const savedSessions: SerializableSession[] = JSON.parse(data);

        for (const session of savedSessions) {
          // Convert startedAt back to Date object
          const restoredSession: Session = {
            ...session,
            startedAt: new Date(session.startedAt),
          };
          this.sessions.set(session.id, restoredSession);
        }

        console.log(`📊 Restored ${savedSessions.length} session(s) from disk`);
      }
    } catch (error) {
      console.error('❌ Failed to load sessions from disk:', error);
    }
  }

  /**
   * Save sessions to disk
   */
  private saveSessions(): void {
    try {
      // Ensure auth_info directory exists
      const dir = path.dirname(SESSIONS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Convert sessions to serializable format (remove ChildProcess)
      const serializableSessions: SerializableSession[] = Array.from(this.sessions.values()).map(session => {
        const { metadata, ...rest } = session;
        if (metadata) {
          const { tunnelProcess, ...serializableMetadata } = metadata;
          return { ...rest, metadata: serializableMetadata };
        }
        return rest;
      });

      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(serializableSessions, null, 2), 'utf-8');
      console.log(`💾 Saved ${serializableSessions.length} session(s) to disk`);
    } catch (error) {
      console.error('❌ Failed to save sessions to disk:', error);
    }
  }

  /**
   * Add a new session
   */
  addSession(session: Session): void {
    this.sessions.set(session.id, session);
    console.log(`📊 Session added: ${session.type} (${session.id})`);
    this.saveSessions(); // Persist to disk
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
      this.saveSessions(); // Persist to disk
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
      this.saveSessions(); // Persist to disk
    }
  }

  /**
   * Update session metadata (e.g., cloudflared URL)
   */
  updateSessionMetadata(id: string, metadata: Partial<Session['metadata']>): void {
    const session = this.sessions.get(id);
    if (session) {
      session.metadata = { ...session.metadata, ...metadata };
      this.saveSessions(); // Persist to disk
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
