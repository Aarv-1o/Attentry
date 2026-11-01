export async function renameRoom(id: string, name: string) {
  return fetch(`/api/rooms/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
}

export async function reorderRooms(ids: string[]) {
  return fetch("/api/rooms/order", { method: "PUT", body: JSON.stringify({ ids }) });
}
