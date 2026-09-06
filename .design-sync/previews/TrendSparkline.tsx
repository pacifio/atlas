import { TrendSparkline } from "atlas";

const RISING = [12, 14, 13, 17, 16, 21, 20, 26, 25, 31, 34, 38];
const FALLING = [38, 36, 37, 31, 29, 30, 24, 22, 23, 17, 15, 12];

export const Rising = () => (
  <TrendSparkline points={RISING} label="Turns per day, up 216% over 12 days" />
);

export const Falling = () => (
  <TrendSparkline points={FALLING} label="Tokens per turn, down 68% over 12 days" />
);

export const InAStatRow = () => (
  <div className="flex items-center gap-4">
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">
        Agent turns
      </span>
      <span className="text-[15px] font-medium text-[var(--text-primary)]">1,284</span>
    </div>
    <TrendSparkline points={RISING} width={120} height={32} label="Agent turns trend" />
  </div>
);

export const Wide = () => (
  <TrendSparkline points={RISING} width={240} height={48} label="Wide sparkline" />
);
