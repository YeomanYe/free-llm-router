import { useReveal } from "../useReveal";
import "./Install.css";

const STEPS = [
  {
    label: "01",
    title: "Install",
    body: "One dependency (zod), no bundler, no runtime magic.",
    code: "pnpm add free-llm-router"
  },
  {
    label: "02",
    title: "Point at your env",
    body: "Set FLR_ENV_FILE once, or drop a symlink at ~/.flr/env.",
    code: "export FLR_ENV_FILE=~/.env.local"
  },
  {
    label: "03",
    title: "Ship",
    body: "Sequential fallback, parallel race, quota probing — same config.",
    code: 'flr chat "your prompt here"'
  }
];

export default function Install() {
  const ref = useReveal();
  return (
    <section id="install" className="install">
      <div className="wrap install-inner" ref={ref}>
        <div className="install-header reveal">
          <span className="eyebrow">Get started</span>
          <h2 className="section-title">Three lines to route.</h2>
        </div>
        <ol className="install-steps">
          {STEPS.map((step) => (
            <li key={step.label} className="install-step reveal">
              <div className="install-step-head">
                <span className="install-step-num mono">{step.label}</span>
                <h3 className="install-step-title">{step.title}</h3>
              </div>
              <p className="install-step-body">{step.body}</p>
              <pre className="install-step-code mono">
                <span className="term-prompt">$</span> {step.code}
              </pre>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
