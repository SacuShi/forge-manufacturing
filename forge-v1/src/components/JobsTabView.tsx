import { itemIconUrl } from '../utils/icons';
import { type ActiveJob } from '../types';
import type { FC } from 'react';

interface JobsTabViewProps {
  activeJobs: ActiveJob[];
  activeTab: string;
  activityLabel: (id: number | undefined) => string;
  onSelectItem: (typeId: number, name: string) => void;
  selectedTypeId: number | null;
}

const JobsTabView: FC<JobsTabViewProps> = ({ activeJobs, activeTab, activityLabel, onSelectItem, selectedTypeId }) => {
  return (
    <>
{activeTab === 'jobs' && (
        <div className="main-panel">
          {activeJobs.length === 0 ? (
            <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13,
              padding: 24, textAlign: 'center' }}>
              No active industry jobs
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {activeJobs.map((job) => {
                const label = activityLabel(job.activityId);
                const isJobSelected = job.typeId === selectedTypeId;
                return (
                <div
                  key={`${job.name}-${job.remaining}-${job.activityId ?? 0}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`View details for ${job.name}`}
                  onClick={() => onSelectItem(job.typeId, job.name)}
                  onKeyDown={(e) => e.key === 'Enter' && onSelectItem(job.typeId, job.name)}
                  style={{
                    background: isJobSelected ? 'rgba(212, 150, 14, 0.20)' : 'var(--color-bg-tertiary)',
                    border: '0.5px solid',
                    borderColor: isJobSelected ? 'rgba(212, 150, 14, 0.55)' : 'var(--color-border-light)',
                    boxShadow: isJobSelected ? 'inset 0 0 0 1px rgba(212, 150, 14, 0.55)' : undefined,
                    borderRadius: 4,
                    padding: '10px 14px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    cursor: 'pointer',
                    transition: 'border-color 0.1s, box-shadow 0.1s',
                  }}
                  onMouseEnter={(e) => {
                    if (!isJobSelected) (e.currentTarget as HTMLDivElement).style.boxShadow = 'inset 0 0 0 1px rgba(212, 150, 14, 0.55)';
                  }}
                  onMouseLeave={(e) => {
                    if (!isJobSelected) (e.currentTarget as HTMLDivElement).style.boxShadow = '';
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                    <img
                      src={itemIconUrl(job.typeId)}
                      alt={job.name}
                      loading="lazy"
                      crossOrigin="anonymous"
                      style={{ width: 32, height: 32, flexShrink: 0, borderRadius: 2, opacity: 0.9 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {label && (
                        <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)',
                          letterSpacing: '0.5px', marginBottom: 2, textTransform: 'uppercase' }}>
                          {label}
                        </div>
                      )}
                      <span style={{ fontSize: 13, color: 'var(--color-text-secondary)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                        {job.quantity > 1 ? `×${job.quantity} ` : ''}{job.name}
                      </span>
                    </div>
                  </div>
                  <span style={{
                    fontSize: 12,
                    color: job.done ? 'var(--color-success)' : 'var(--color-warning)',
                    fontWeight: 500,
                    flexShrink: 0,
                    marginLeft: 12,
                  }}>
                    {job.remaining}
                  </span>
                </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </>
  );
};

export default JobsTabView;
