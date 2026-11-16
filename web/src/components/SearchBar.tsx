import type { FormEvent } from "react";

export function SearchBar({
  value,
  onChange,
  onSearch,
  busy,
}: {
  value: string;
  onChange: (q: string) => void;
  onSearch: (q: string) => void;
  busy: boolean;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) onSearch(value);
  };

  return (
    <form className="search-bar" role="search" onSubmit={submit}>
      <label htmlFor="search" className="visually-hidden">
        Search contracts
      </label>
      <input
        id="search"
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search contracts, e.g. limitation of liability"
        autoComplete="off"
      />
      <button type="submit" className="btn btn-primary" disabled={!value.trim()}>
        <span className={busy ? "spinner" : "spinner spinner-idle"} aria-hidden="true" />
        Search
      </button>
    </form>
  );
}
