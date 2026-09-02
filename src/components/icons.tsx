/* Iconos SVG dibujados a mano (trazo currentColor, sin dependencias). */

interface IconProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
}

function base(props: IconProps) {
  const { size = 22, className = "", strokeWidth = 1.8 } = props;
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };
}

export function MicIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3.5" />
      <path d="M8.5 21.5h7" />
    </svg>
  );
}

export function PauseIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="6.5" y="4.5" width="3.6" height="15" rx="1.2" />
      <rect x="13.9" y="4.5" width="3.6" height="15" rx="1.2" />
    </svg>
  );
}

export function PlayIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M7.5 4.8v14.4c0 .8.9 1.3 1.6.9l11-7.2c.6-.4.6-1.4 0-1.8l-11-7.2c-.7-.4-1.6.1-1.6.9Z" />
    </svg>
  );
}

export function SendIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M21.5 2.5 11 13" />
      <path d="M21.5 2.5 14.8 21.6c-.3.8-1.4.9-1.8.1L11 13l-8.7-2.3c-.8-.2-.8-1.3 0-1.6L21.5 2.5Z" />
    </svg>
  );
}

export function SpeakerOnIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M11.5 4.5 6.8 8.5H3.5v7h3.3l4.7 4v-15Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.2 6a9 9 0 0 1 0 12" />
    </svg>
  );
}

export function SpeakerOffIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M11.5 4.5 6.8 8.5H3.5v7h3.3l4.7 4v-15Z" />
      <path d="m16 9.5 5 5" />
      <path d="m21 9.5-5 5" />
    </svg>
  );
}

export function KeyIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="8" cy="15.5" r="4.5" />
      <path d="m11.3 12.2 8.2-8.2" />
      <path d="M17 6.5 19.5 9" />
      <path d="m14.2 9.3 2 2" />
    </svg>
  );
}

export function NeuronIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 8.8V4.2" />
      <path d="m14.8 13.6 4.3 2.4" />
      <path d="m9.2 13.6-4.3 2.4" />
      <path d="m9.5 10.2-3.8-3" />
      <path d="m14.5 10.2 3.8-3" />
      <circle cx="12" cy="3.4" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="19.8" cy="16.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="4.2" cy="16.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="5" cy="6.6" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="6.6" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function HistoryIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5" />
      <path d="M3.5 3.5v5h5" />
      <path d="M12 7.5V12l3.2 2" />
    </svg>
  );
}

export function TrashIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 6.5h16" />
      <path d="M9.5 6.5V4.8c0-.7.6-1.3 1.3-1.3h2.4c.7 0 1.3.6 1.3 1.3v1.7" />
      <path d="M6.2 6.5 7 19.2c0 .7.6 1.3 1.3 1.3h7.4c.7 0 1.3-.6 1.3-1.3l.8-12.7" />
      <path d="M10 10.5v6" />
      <path d="M14 10.5v6" />
    </svg>
  );
}

export function AlertIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 3.5 1.9 20.5h20.2L12 3.5Z" />
      <path d="M12 9.5v5" />
      <circle cx="12" cy="17.5" r="0.4" fill="currentColor" />
    </svg>
  );
}

export function EyeIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function EyeOffIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 4l16 16" />
      <path d="M9.9 5.9A9.4 9.4 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17.6 17.6 0 0 1-3.2 3.9M6 7.2A17 17 0 0 0 2.5 12S6 18.5 12 18.5c1.2 0 2.3-.3 3.3-.7" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}

export function TerminalIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="2.5" y="4" width="19" height="16" rx="2" />
      <path d="m6.5 9 3 3-3 3" />
      <path d="M12 15.5h5" />
    </svg>
  );
}

export function UploadIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 15V3.5" />
      <path d="m7.5 8 4.5-4.5L16.5 8" />
      <path d="M4 15.5v3A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5v-3" />
    </svg>
  );
}

export function GlobeIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14.5 14.5 0 0 1 0 18 14.5 14.5 0 0 1 0-18Z" />
    </svg>
  );
}

export function GitBranchIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <circle cx="18" cy="8" r="2.2" />
      <path d="M6 7.2v9.6" />
      <path d="M18 10.2c0 3.4-2.8 5-6.2 5H8.3" />
    </svg>
  );
}

export function ZapIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12l1-8Z" />
    </svg>
  );
}
