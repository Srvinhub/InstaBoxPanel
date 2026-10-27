export interface DesktopAction { time: string; tool: string; refused: boolean }
export interface DesktopState {
  installed: boolean; installing: boolean; running: boolean; failed: boolean;
  agentPausable: boolean; controller: 'agent' | 'human'; yours: boolean;
  controlError: string; actions: DesktopAction[];
}
export type DesktopCommand = 'install' | 'start' | 'takeover' | 'handback';
export interface MachineSnapshot {
  id: string; name: string; description: string; orgId: string; sourceMachineId: string;
  status: 'pending' | 'ready' | 'failed'; createdAt: string; rootSizeBytes: number;
  dataSizeBytes: number | null; error: string;
}
export interface SnapshotPayload { name: string; description: string; rootOnly: boolean }
export interface SnapshotRequest {
  id: string; machineId: string; type: 'create' | 'delete'; snapshotId: string | null;
  name: string; payload: SnapshotPayload | { confirmName: string };
  state: 'submitting' | 'pending' | 'succeeded' | 'failed' | 'unknown';
  error: string; createdAt: string; updatedAt: string;
}
export interface SnapshotOverview { snapshots: MachineSnapshot[]; requests: SnapshotRequest[] }
