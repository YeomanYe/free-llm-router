import Hero from "./sections/Hero";
import Cli from "./sections/Cli";
import Providers from "./sections/Providers";
import Features from "./sections/Features";
import Install from "./sections/Install";
import Footer from "./sections/Footer";
import Nav from "./sections/Nav";
import "./app.css";

export default function App() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <hr className="rule wrap-rule" />
        <Install />
        <hr className="rule wrap-rule" />
        <Cli />
        <hr className="rule wrap-rule" />
        <Providers />
        <hr className="rule wrap-rule" />
        <Features />
      </main>
      <Footer />
    </>
  );
}
