import * as path from "node:path";
import * as os from "node:os";
import {
  AgentStore,
  RoomManager,
  RoutineEngine,
  SkillStore,
  VaultStore,
  TaskStore,
  AttachmentManager,
  MemoryStore,
} from "@opensand/coordinator";

export async function getFleetStatus(baseDir?: string) {
  const root = baseDir || path.join(os.homedir(), ".opensand");
  const agentStore = new AgentStore(path.join(root, "agents"));
  const vaultStore = new VaultStore({ baseDir: path.join(root, "vault") });
  const roomManager = new RoomManager(path.join(root, "rooms"), agentStore, vaultStore);
  const routineEngine = new RoutineEngine(path.join(root, "routines"), vaultStore);
  const skillStore = new SkillStore({ baseDir: path.join(root, "skills"), agentStore });
  const taskStore = new TaskStore(path.join(root, "tasks"));
  const attachmentManager = new AttachmentManager(path.join(root, "attachments"));
  const memoryStore = new MemoryStore({ baseDir: path.join(root, "memories") });

  const [agents, rooms, routines, skills, secrets, creds, tasks, attachments, memories] =
    await Promise.all([
      agentStore.listAgents().catch(() => []),
      roomManager.listRooms().catch(() => []),
      routineEngine.listRoutines().catch(() => []),
      skillStore.listSkills().catch(() => []),
      vaultStore.listSecrets().catch(() => []),
      vaultStore.listCredentials().catch(() => []),
      taskStore.listTasks().catch(() => []),
      attachmentManager.listAttachments().catch(() => []),
      memoryStore.listMemories({}).catch(() => []),
    ]);

  return {
    agents,
    rooms,
    routines,
    skills,
    secrets,
    creds,
    tasks,
    attachments,
    memories,
  };
}
