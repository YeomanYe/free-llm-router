import "./Nav.css";

export default function Nav() {
  return (
    <header className="nav">
      <div className="wrap nav-inner">
        <a href="#top" className="nav-brand">
          <span className="nav-brand-mark mono">flr</span>
          <span className="nav-brand-name">free-llm-router</span>
        </a>
        <nav className="nav-links">
          <a href="#cli">CLI</a>
          <a href="#providers">Providers</a>
          <a href="#features">Router</a>
          <a
            className="nav-github"
            href="https://github.com/YeomanYe/free-llm-router"
            target="_blank"
            rel="noreferrer"
          >
            GitHub ↗
          </a>
        </nav>
      </div>
    </header>
  );
}
