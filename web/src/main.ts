import { registerSW } from "virtual:pwa-register";
import "./styles.css";
import "./components/cc-app";

registerSW({ immediate: true });
