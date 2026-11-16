export function App({ version }: { version: string }) {
  return (
    <div className="app">
      <header>
        <h1>Redline</h1>
      </header>
      <main>
        <label htmlFor="search">Search contracts</label>
        <input
          id="search"
          type="search"
          disabled
          placeholder="Search coming soon"
          aria-describedby="search-hint"
        />
        <p id="search-hint">Search coming soon</p>
      </main>
      <footer>
        <small>Version {version}</small>
      </footer>
    </div>
  );
}
