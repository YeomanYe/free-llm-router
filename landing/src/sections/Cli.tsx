import { useState } from "react";
import { commands } from "../data";
import { useReveal } from "../useReveal";
import "./Cli.css";

export default function Cli() {
  const [active, setActive] = useState(0);
  const ref = useReveal();
  const cmd = commands[active];

  return (
    <section id="cli" className="cli">
      <div className="wrap cli-inner" ref={ref}>
        <div className="cli-header reveal">
          <span className="eyebrow">The CLI</span>
          <h2 className="section-title">
            Five commands.
            <br />
            <span className="cli-title-accent">One shared config.</span>
          </h2>
          <p className="cli-lead">
            Every command reads the same providers, applies the same tier + filter
            language, and writes into the same in-memory usage counters.
          </p>
        </div>

        <div className="cli-tabs reveal" role="tablist" aria-label="CLI commands">
          {commands.map((c, i) => (
            <button
              key={c.name}
              role="tab"
              aria-selected={i === active}
              className={"cli-tab" + (i === active ? " is-active" : "")}
              onClick={() => setActive(i)}
            >
              <span className="mono cli-tab-name">flr {c.name}</span>
              <span className="cli-tab-hint">{c.tag}</span>
            </button>
          ))}
        </div>

        <div className="cli-panel reveal">
          <div className="cli-panel-body">
            <p className="cli-blurb">{cmd.blurb}</p>
            <pre className="cli-code mono">
              <code>{cmd.code}</code>
            </pre>
          </div>
          <aside className="cli-side">
            <dl>
              <dt>Signature</dt>
              <dd className="mono">flr {cmd.name} [flags] [prompt]</dd>
              <dt>Shared flags</dt>
              <dd>--tier · --model(s) · --providers · --sort-by · --min-quality · --min-ctx · --fallback-to-rest · --stats</dd>
              <dt>Programmatic</dt>
              <dd className="mono">router.{apiFor(cmd.name)}(&#123; messages, tier &#125;)</dd>
            </dl>
          </aside>
        </div>
      </div>
    </section>
  );
}

function apiFor(name: string): string {
  switch (name) {
    case "race":
      return "chatRace";
    case "broadcast":
      return "chatAll";
    case "models":
      return "listModels";
    case "quota":
      return "getUsage";
    default:
      return "chat";
  }
}
