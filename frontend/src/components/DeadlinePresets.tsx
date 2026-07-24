import { DEADLINE_PRESETS, dateToLocalInput } from "../datetime";

// A row of quick relative deadlines to sit under a `datetime-local` input. Clicking one only fills
// the input — saving stays explicit (a Save button or a form submit), so a stray click is never a
// change to the issue. `type="button"` keeps these from submitting the form they may live in.
export function DeadlinePresets({ onPick }: { onPick: (localInput: string) => void }) {
  return (
    <span className="row" style={{ marginTop: 6 }}>
      {DEADLINE_PRESETS.map((p) => (
        <button
          key={p.label}
          type="button"
          className="ghost small"
          title={`Set the deadline to ${p.label.toLowerCase()} (you still have to save)`}
          onClick={() => onPick(dateToLocalInput(p.at(new Date())))}
        >
          {p.label}
        </button>
      ))}
    </span>
  );
}
