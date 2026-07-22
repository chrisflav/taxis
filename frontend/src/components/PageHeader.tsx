import type { ReactNode } from "react";

/**
 * The heading block every top-level page opens with.
 *
 * These pages had drifted into four different shapes — some titles bare, some sharing a row with
 * their buttons, some with a line of help text and some without, and two with the help text pushed
 * under the controls by a negative margin. Since the spacing below a title is what tells you where
 * a page begins, the differences read as pages that were built at different times.
 *
 * So: one component, one set of spacings, and a description on every page rather than on some.
 * `description` is what this page is for, in a line — not how to operate a control on it, which
 * belongs beside the control.
 */
export function PageHeader({
  title, description, actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header-top">
        <h2>{title}</h2>
        {actions && <div className="row">{actions}</div>}
      </div>
      {description && <p className="page-description">{description}</p>}
    </header>
  );
}
