/** On/off switch for synonym expansion, shown beside the search box. */
export function SynonymToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Synonyms"
      title={on ? "Searches also match synonyms" : "Searches match your words only"}
      className={`switch${on ? " is-on" : ""}`}
      onClick={() => onChange(!on)}
    >
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      <span className="switch-label">Synonyms</span>
      <span className="switch-state" aria-hidden="true">
        {on ? "On" : "Off"}
      </span>
    </button>
  );
}
