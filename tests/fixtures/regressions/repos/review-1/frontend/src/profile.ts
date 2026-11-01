import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const followUser = async (username: string, id: number) => {
  const profile = await prisma.user.update({ where: { username }, data: { followedBy: { connect: { id } } }, include: { followedBy: true } });
  return { username: profile.username, following: profile.followedBy.some((f) => f.id === id) };
};

export const unfollowUser = async (username: string, id: number) => {
  const profile = await prisma.user.update({ where: { username }, data: { followedBy: { disconnect: { id } } }, include: { followedBy: true } });
  return { username: profile.username, following: profile.followedBy.some((f) => f.id === id) };
};
