// Vanilla TS — no JSX, no framework. The app builds DOM at runtime, so
// these elements have NO authored source mapping: the honest inspector
// reports them as dynamic nodes with facts + styles only.
const app = document.getElementById("app");

const card = document.createElement("div");
card.id = "dynamic-card";
card.className = "card";

const note = document.createElement("p");
note.id = "dynamic-note";
note.textContent = "Created at runtime";
card.appendChild(note);

app?.appendChild(card);

const canvas = document.getElementById("arena") as HTMLCanvasElement | null;
canvas?.getContext("2d")?.fillRect(4, 4, 24, 24);
