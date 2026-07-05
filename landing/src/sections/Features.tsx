import { features } from "../data";
import { useReveal } from "../useReveal";
import "./Features.css";

export default function Features() {
  const ref = useReveal();
  return (
    <section id="features" className="features">
      <div className="wrap features-inner" ref={ref}>
        <div className="features-header reveal">
          <span className="eyebrow">Inside the router</span>
          <h2 className="section-title">
            Not just a switch.
            <br />
            <span className="features-title-sub">A proper router.</span>
          </h2>
        </div>

        <ul className="features-grid">
          {features.map((f, i) => (
            <li key={f.title} className="feature reveal">
              <span className="feature-index mono">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="feature-title">{f.title}</h3>
              <p className="feature-body">{f.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
