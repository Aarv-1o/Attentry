export function RoomList({ rooms }: { rooms: string[] }) {
  return <ul>{rooms.map((r) => <li key={r}>{r}</li>)}</ul>;
}
