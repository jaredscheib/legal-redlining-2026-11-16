import { useRef, type FormEvent } from "react";

export function SearchBar({
  value,
  onChange,
  onSearch,
  onClear,
  busy,
}: {
  value: string;
  onChange: (q: string) => void;
  onSearch: (q: string) => void;
  /** Called when the box is emptied, by the clear button or by typing. */
  onClear: () => void;
  busy: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) onSearch(value);
  };

  return (
    <form className="search-bar" role="search" onSubmit={submit}>
      <label htmlFor="search" className="visually-hidden">
        Search contracts
      </label>
      <div className="search-field">
        <input
          ref={inputRef}
          id="search"
          type="search"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            if (!e.target.value) onClear();
          }}
          placeholder="Search contracts, e.g. limitation of liability"
          autoComplete="off"
        />
        {value && (
          <button
            type="button"
            className="search-clear"
            aria-label="Clear search"
            title="Clear search"
            onClick={() => {
              onChange("");
              onClear();
              inputRef.current?.focus();
            }}
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>
      <button type="submit" className="btn btn-primary" disabled={!value.trim()}>
        <span className={busy ? "spinner" : "spinner spinner-idle"} aria-hidden="true" />
        Search
      </button>
    </form>
  );
}
