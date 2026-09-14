export function Navbar() {
  return (
    <nav style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <circle cx="9" cy="9" r="8" fill="#4f8cff" />
        <path d="M5 9h8M9 5v8" stroke="#fff" strokeWidth="2" />
      </svg>
      <a href="#home">Home</a>
      <a href="#about">About</a>
    </nav>
  );
}
