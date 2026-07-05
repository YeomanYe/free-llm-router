import "./Footer.css";

export default function Footer() {
  return (
    <footer className="footer">
      <div className="wrap footer-inner">
        <div className="footer-brand">
          <div className="footer-mark mono">flr</div>
          <p className="footer-tagline">
            Open source · MIT · Config-driven Node.js router for free-tier LLM
            providers.
          </p>
        </div>

        <div className="footer-links">
          <div className="footer-col">
            <div className="footer-col-head mono">Project</div>
            <a href="https://github.com/YeomanYe/free-llm-router" target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a
              href="https://github.com/YeomanYe/free-llm-router#readme"
              target="_blank"
              rel="noreferrer"
            >
              README
            </a>
            <a
              href="https://github.com/YeomanYe/free-llm-router/blob/main/router.config.example.json"
              target="_blank"
              rel="noreferrer"
            >
              Example config
            </a>
          </div>
          <div className="footer-col">
            <div className="footer-col-head mono">Docs on GitHub</div>
            <a
              href="https://github.com/YeomanYe/free-llm-router/tree/main/src"
              target="_blank"
              rel="noreferrer"
            >
              Router internals
            </a>
            <a
              href="https://github.com/YeomanYe/free-llm-router/tree/main/tests"
              target="_blank"
              rel="noreferrer"
            >
              Test suite
            </a>
          </div>
        </div>
      </div>
      <div className="wrap footer-tail">
        <span className="mono">© {new Date().getFullYear()} · free-llm-router</span>
        <span className="mono">Built with pnpm · vite · react</span>
      </div>
    </footer>
  );
}
