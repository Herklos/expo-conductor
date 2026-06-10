/**
 * ConductorProvider — subscribes to lifecycle events and persists execution history.
 * Wrap the app shell with this provider so all screens share task/history state.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import Conductor, {
  foldHistory,
  type RegisteredTask,
  type TaskExecutionRecord,
} from 'expo-conductor';

export type TriggerMode =
  | 'interval'
  | 'alarm'
  | 'notification'
  | 'time'
  | 'background'
  | 'appState'
  | 'push'
  | 'userInitiatedBackground';

export interface ScheduleConfig {
  kind: 'interval' | 'daily' | 'weekly' | 'cron';
  everyMs: number;   // interval kind
  hour: number;      // daily / weekly
  minute: number;    // daily / weekly
  weekday: number;   // weekly (0 = Sun)
  cron: string;      // 3-field "minute hour dayOfWeek"
}

const DEFAULT_SCHEDULE: ScheduleConfig = {
  kind: 'interval',
  everyMs: 30_000,
  hour: 9,
  minute: 0,
  weekday: 1,
  cron: '0 9 *',
};

function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

interface ConductorContextValue {
  tasks: RegisteredTask[];
  records: TaskExecutionRecord[];
  liveLog: string[];
  triggerMode: TriggerMode;
  setTriggerMode: (m: TriggerMode) => void;
  scheduleConfig: ScheduleConfig;
  setScheduleConfig: (c: ScheduleConfig) => void;
  refresh: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  clearHistory: () => Promise<void>;
  clearLiveLog: () => void;
}

const ConductorContext = createContext<ConductorContextValue>({
  tasks: [],
  records: [],
  liveLog: [],
  triggerMode: 'interval',
  setTriggerMode: () => {},
  scheduleConfig: DEFAULT_SCHEDULE,
  setScheduleConfig: () => {},
  refresh: async () => {},
  refreshHistory: async () => {},
  clearHistory: async () => {},
  clearLiveLog: () => {},
});

export function ConductorProvider({ children }: { children: React.ReactNode }) {
  const [tasks, setTasks] = useState<RegisteredTask[]>([]);
  const [records, setRecords] = useState<TaskExecutionRecord[]>([]);
  const [liveLog, setLiveLog] = useState<string[]>([]);
  const [triggerMode, setTriggerMode] = useState<TriggerMode>('interval');
  const [scheduleConfig, setScheduleConfig] = useState<ScheduleConfig>(DEFAULT_SCHEDULE);
  const logRef = useRef<string[]>([]);

  const appendLog = useCallback((line: string) => {
    const time = fmtDateTime(Date.now());
    const entry = `${time}  ${line}`;
    logRef.current = [entry, ...logRef.current].slice(0, 100);
    setLiveLog([...logRef.current]);
  }, []);

  const refresh = useCallback(async () => {
    setTasks(await Conductor.getTasks());
  }, []);

  const refreshHistory = useCallback(async () => {
    const events = await Conductor.getHistory();
    setRecords(foldHistory(events));
  }, []);

  const clearHistory = useCallback(async () => {
    await Conductor.clearHistory();
    setRecords([]);
  }, []);

  const clearLiveLog = useCallback(() => {
    logRef.current = [];
    setLiveLog([]);
  }, []);

  useEffect(() => {
    const subs = [
      Conductor.addListener('onTaskExecute', (p) => {
        appendLog(`execute → ${p.taskId} (trigger=${p.triggerType}, attempt=${p.attempt})`);
        void refreshHistory();
      }),
      Conductor.addListener('onTaskComplete', (p) => {
        appendLog(`complete → ${p.taskId} (${p.result})`);
        void refreshHistory();
      }),
      Conductor.addListener('onTaskSkipped', (p) => {
        appendLog(`skipped → ${p.taskId} (${p.reason})`);
        void refreshHistory();
      }),
      Conductor.addListener('onTaskError', (p) => {
        appendLog(`error → ${p.taskId} (${p.error})`);
        void refreshHistory();
      }),
    ];
    void refresh();
    void refreshHistory();
    return () => subs.forEach((s) => s.remove());
  }, [appendLog, refresh, refreshHistory]);

  return (
    <ConductorContext.Provider
      value={{ tasks, records, liveLog, triggerMode, setTriggerMode, scheduleConfig, setScheduleConfig, refresh, refreshHistory, clearHistory, clearLiveLog }}
    >
      {children}
    </ConductorContext.Provider>
  );
}

export function useConductor() {
  return useContext(ConductorContext);
}
