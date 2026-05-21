import { DemoApp } from "./demo/DemoApp";
import { RealApp } from "./RealApp";

export function App() {
  if (typeof window !== "undefined" && window.location.pathname.startsWith("/demo")) {
    return <DemoApp />;
  }
  return <RealApp />;
}
