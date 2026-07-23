// EVE Photon UI-style nav icons — thin stroke, geometric, currentColor
// Shared between MainContent (tab bar) and LeftSidebar (nav strip).

import { type FC } from 'react';

const Ico: FC<{ children: React.ReactNode }> = ({ children }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
    stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" style={{ flexShrink: 0 }}>
    {children}
  </svg>
);

export const IconMarket: FC = () => <Ico>
  <line x1="1.5" y1="14" x2="14.5" y2="14"/>
  <path d="M2.5 14V10.5H5V14M6.5 14V6.5H9V14M10.5 14V3H13V14"/>
</Ico>;

export const IconBlueprint: FC = () => <Ico>
  <rect x="2.5" y="1" width="9" height="14" rx="1"/>
  <line x1="2.5" y1="5" x2="11.5" y2="5"/>
  <line x1="7" y1="1" x2="7" y2="5"/>
  <line x1="2.5" y1="8.5" x2="11.5" y2="8.5"/>
  <line x1="2.5" y1="12" x2="9" y2="12"/>
</Ico>;

export const IconResearch: FC = () => <Ico>
  <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none"/>
  <ellipse cx="8" cy="8" rx="6.5" ry="2.5"/>
  <ellipse cx="8" cy="8" rx="6.5" ry="2.5" transform="rotate(60 8 8)"/>
</Ico>;

export const IconAssets: FC = () => <Ico>
  <path d="M8 2L14 5.5V12L8 15.5L2 12V5.5L8 2Z"/>
  <path d="M8 8.5V15.5M2 5.5L8 8.5L14 5.5"/>
</Ico>;

export const IconJobs: FC = () => <Ico>
  <path d="M7 1h2l.5 2.3c.6.2 1.2.6 1.7 1l2.1-.9 1 1.7-1.8 1.4c.1.3.1.7.1 1s0 .7-.1 1l1.8 1.4-1 1.7-2.1-.9c-.5.4-1.1.8-1.7 1L9 15H7l-.5-2.3c-.6-.2-1.2-.6-1.7-1l-2.1.9-1-1.7 1.8-1.4c-.1-.3-.1-.7-.1-1s0-.7.1-1l-1.8-1.4 1-1.7 2.1.9c.5-.4 1.1-.8 1.7-1L7 1z"/>
  <circle cx="8" cy="8" r="2.2"/>
</Ico>;

export const IconQueue: FC = () => <Ico>
  <line x1="1.5" y1="4"  x2="11"  y2="4"/>
  <line x1="1.5" y1="8"  x2="11"  y2="8"/>
  <line x1="1.5" y1="12" x2="8"   y2="12"/>
  <polyline points="10,10 12.5,12.5 15.5,9"/>
</Ico>;

export const IconPI: FC = () => <Ico>
  <circle cx="8" cy="8" r="4"/>
  <ellipse cx="8" cy="8" rx="7" ry="2.5"/>
</Ico>;

export const IconCorp: FC = () => <Ico>
  <rect x="3" y="6" width="10" height="9"/>
  <path d="M1.5 15h13M6.5 6V4.5a1.5 1.5 0 0 1 3 0V6"/>
  <rect x="5"   y="8"   width="2" height="1.5" rx="0.3"/>
  <rect x="9"   y="8"   width="2" height="1.5" rx="0.3"/>
  <rect x="6.5" y="11"  width="3" height="4"/>
</Ico>;

export const IconTrading: FC = () => <Ico>
  <path d="M2 5.5h10M9.5 2.5l2.5 3-2.5 3"/>
  <path d="M14 10.5H4M6.5 7.5l-2.5 3 2.5 3"/>
</Ico>;

export const IconInterhub: FC = () => <Ico>
  <circle cx="2.5" cy="8" r="2"/>
  <circle cx="13.5" cy="8" r="2"/>
  <line   x1="4.5"  y1="8" x2="9.5" y2="8"/>
  <polyline points="8,5.5 11.5,8 8,10.5"/>
</Ico>;

export const IconLPStore: FC = () => <Ico>
  <path d="M8 1.5l1.8 3.6 4 .6-2.9 2.8.7 4L8 10.4l-3.6 1.9.7-4-2.9-2.8 4-.6L8 1.5z"/>
</Ico>;
