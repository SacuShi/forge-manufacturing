import type { FC } from 'react';

interface ForgeWaitProps {
  message: string;
  detail?: string;
  quip?: string;
}

const ForgeWait: FC<ForgeWaitProps> = ({ message, detail, quip }) => (
  <div className="forge-wait">
    <div className="forge-wait-spinner" aria-hidden="true" />
    <div className="forge-wait-message">{message}</div>
    {detail && <div className="forge-wait-detail">{detail}</div>}
    {quip   && <div className="forge-wait-quip">{quip}</div>}
  </div>
);

export default ForgeWait;
