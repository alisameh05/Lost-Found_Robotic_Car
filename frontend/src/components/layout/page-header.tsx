import type { ReactNode } from "react";

export function PageActions({ children, priority }: { children?: ReactNode; priority?: ReactNode }) {
  return (
    <div className="page-actions">
      {children}
      {priority && <div className="page-priority-action">{priority}</div>}
    </div>
  );
}

export function PageHeader({
  title, description, context, actions, priorityAction,
}: { title: string; description?: string; context?: string; actions?: ReactNode; priorityAction?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
        {context && <p className="phase-label">{context}</p>}
      </div>
      {(actions || priorityAction) && <PageActions priority={priorityAction}>{actions}</PageActions>}
    </header>
  );
}
