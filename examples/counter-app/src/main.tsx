import { createRoot } from "react-dom/client";
import { Counter } from "./Counter.js";

const root = document.getElementById("root");
if (root) createRoot(root).render(<Counter />);
