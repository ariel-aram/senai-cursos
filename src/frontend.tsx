import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Root from "./App";

const elem = document.getElementById("root");
if (!elem) throw new Error("Root element not found");

const app = (
	<StrictMode>
		<Root />
	</StrictMode>
);

// import.meta.hot is only defined when development: true (HMR enabled).
// In production (bun start) it is undefined, so fall back to a plain createRoot.
if (import.meta.hot) {
	if (!import.meta.hot.data.root) {
		import.meta.hot.data.root = createRoot(elem);
	}
	import.meta.hot.data.root.render(app);
} else {
	createRoot(elem).render(app);
}
