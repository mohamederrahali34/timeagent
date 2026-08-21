export interface WorkspaceState {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

const key = "timeagent.protectionEnabled";

export class ProtectionState {
  constructor(private readonly state: WorkspaceState) {}
  isEnabled(): boolean { return this.state.get(key, false); }
  async setEnabled(enabled: boolean): Promise<void> { await this.state.update(key, enabled); }
}
