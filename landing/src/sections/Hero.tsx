import { useEffect, useState } from "react";
import { useReveal } from "../useReveal";
import "./Hero.css";

// Types out the CLI once on first paint so the hero feels alive without
// devolving into an infinite loop. Falls back to the finished string when
// the user prefers reduced motion.
const HERO_LINE = 'flr chat --tier medium-1 "Explain BM25 in one sentence"';

function useTypedLine(line: string, speedMs = 22): string {
  const [text, setText] = useState("");
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setText(line);
      return;
    }
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      setText(line.slice(0, i));
      if (i >= line.length) window.clearInterval(id);
    }, speedMs);
    return () => window.clearInterval(id);
  }, [line, speedMs]);
  return text;
}

export default function Hero() {
  const ref = useReveal();
  const typed = useTypedLine(HERO_LINE);
  const isDone = typed.length === HERO_LINE.length;

  return (
    <section id="top" className="hero">
      <div className="wrap hero-inner">
        <div className="hero-copy reveal is-in" ref={ref}>
          <span className="eyebrow">v0.1 · MIT · Node ≥ 20</span>
          <h1 className="hero-title">
            One CLI, <br />
            every free-tier LLM.
          </h1>
          <p className="hero-sub">
            free-llm-router fans one prompt across the free-tier keys you already own —
            OpenRouter, Groq, Gemini, Cerebras, BigModel, Cloudflare Workers&nbsp;AI,
            GitHub Models — with sequential fallback, parallel race, quota probing, and
            nine-tier model classification. Pure Node, one <span className="mono">zod</span>
            &nbsp;dependency.
          </p>

          <div className="hero-cta">
            <a className="btn btn-primary" href="#install">
              Install
              <span aria-hidden="true">↓</span>
            </a>
            <a
              className="btn btn-ghost"
              href="https://github.com/YeomanYe/free-llm-router"
              target="_blank"
              rel="noreferrer"
            >
              Source on GitHub
              <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>

        <div className="hero-terminal reveal is-in" aria-hidden="true">
          <div className="term-chrome">
            <div className="term-dots">
              <span />
              <span />
              <span />
            </div>
            <div className="term-title mono">~/projects · zsh</div>
            <div className="term-spacer" />
          </div>
          <div className="term-body mono">
            <div className="term-line">
              <span className="term-prompt">$</span>
              <span className="term-cmd">
                {typed}
                {!isDone && <span className="caret" />}
              </span>
            </div>
            {isDone && (
              <>
                <div className="term-out term-out-dim">
                  routing 12 candidates · tier=medium-1 · sortBy=quality
                </div>
                <div className="term-out">
                  <span className="term-badge">bigmodel/glm-4.5-flash</span>&nbsp;won in 942ms
                </div>
                <div className="term-out">
                  <span className="term-accent">›</span> BM25 is a bag-of-words ranking
                  function that scores a document by summing term-frequency saturation
                  and length-normalisation for each query term.
                </div>
                <div className="term-line">
                  <span className="term-prompt">$</span>
                  <span className="caret caret-idle" />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
