import { createRoot } from "react-dom/client";
import { followUser, unfollowUser } from "./profile";
import { watchScroll } from "./scroll";
import { downloadBlob } from "./download";
import { exportDeck } from "./export";
import { takePending } from "./storage";
import { renameRoom } from "./rooms";

createRoot(document.body).render(null);
watchScroll(() => takePending());
void [followUser, unfollowUser, downloadBlob, exportDeck, renameRoom];
