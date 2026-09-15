import Logo from "./Logo";

export function Navbar() {
  return (
    <nav className="navbar">
      <Logo />
      <a className="nav-link" href="#home">
        Home
      </a>
      <a className="nav-link" href="#about">
        About
      </a>
    </nav>
  );
}
