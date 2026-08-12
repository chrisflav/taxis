/**
 * What a view shows when a read failed and it has nothing to fall back on.
 *
 * Two states, because there are two situations and they are not the same news.
 *
 * The server answering with an error is an *answer*: something is wrong, and the reader is being
 * told what. That gets the error treatment it always had.
 *
 * Nothing answering is a *situation* — no signal, a server that is off, a laptop lid closed on the
 * way to the station. Nothing is broken, nothing needs fixing, and the page will work again by
 * itself when the connection does. Painting that in the same alarming panel as a server fault
 * overstates it; the honest version says what is missing and offers the one action that could
 * change anything.
 *
 * What it deliberately does *not* do is keep showing the loading skeleton. A skeleton says work is
 * in progress, and there is no work in progress — the request has already failed and nothing is
 * retrying. Leaving it up would be a spinner that never resolves, which is the least informative
 * thing the screen could be doing.
 */
export function ReadFailure({
  message,
  offline,
  onRetry,
}: {
  message: string;
  /** True when nothing answered, as opposed to the server having said something. */
  offline: boolean;
  onRetry?: () => void;
}) {
  if (!offline) {
    return (
      <div className="panel error">
        <div>{message}</div>
        {onRetry && (
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={onRetry}>Try again</button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="panel">
      <div className="field-heading">Not available offline</div>
      <p className="small muted" style={{ margin: "6px 0 0" }}>{message}</p>
      <p className="small muted" style={{ margin: "6px 0 0" }}>
        Anything already opened on this device stays readable, and changes you make are sent when
        the connection comes back.
      </p>
      {onRetry && (
        <div className="row" style={{ marginTop: 10 }}>
          <button onClick={onRetry}>Try again</button>
        </div>
      )}
    </div>
  );
}
