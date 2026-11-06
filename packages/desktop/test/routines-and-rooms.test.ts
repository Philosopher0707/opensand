import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { DesktopServer } from '../src/desktop-server.js';

class MockIncomingMessage extends EventEmitter {
  public method: string;
  public url: string;
  public headers: Record<string, string>;
  public static defaultToken: string = '';

  constructor(method: string, url: string, headers: Record<string, string> = {}) {
    super();
    this.method = method;
    this.url = url;
    this.headers = { host: '127.0.0.1:3456', ...headers };
    if (!('authorization' in this.headers) && !('Authorization' in this.headers) && MockIncomingMessage.defaultToken) {
      this.headers['authorization'] = `Bearer ${MockIncomingMessage.defaultToken}`;
    }
  }

  public destroy(): this {
    this.emit('close');
    return this;
  }
}

class MockServerResponse extends EventEmitter {
  public statusCode: number = 200;
  public headers: Record<string, string> = {};
  public body: string = '';

  public setHeader(key: string, val: string) {
    this.headers[key.toLowerCase()] = val;
  }

  public writeHead(code: number, headers?: Record<string, string>) {
    this.statusCode = code;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        this.headers[k.toLowerCase()] = v;
      }
    }
  }

  public write(chunk: string | Buffer) {
    this.body += chunk.toString();
  }

  public end(chunk?: string | Buffer) {
    if (chunk) {
      this.body += chunk.toString();
    }
    this.emit('finish');
  }
}

test('DesktopServer - Routines and Rooms REST API Endpoints', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-routines-rooms-test-'));
  const server = new DesktopServer({ baseDir: tmpDir });
  MockIncomingMessage.defaultToken = server.getAuthToken();

  try {
    // 1. POST /api/routines
    const reqCreateRoutine = new MockIncomingMessage('POST', '/api/routines');
    const resCreateRoutine = new MockServerResponse();
    const createRoutinePromise = (server as any).handleRequest(reqCreateRoutine, resCreateRoutine);
    reqCreateRoutine.emit('data', Buffer.from(JSON.stringify({
      name: 'Hourly Security Audit',
      prompt: 'Check system processes for anomalous activity',
      scheduleType: 'interval',
      intervalMinutes: 60,
    })));
    reqCreateRoutine.emit('end');
    await createRoutinePromise;

    assert.strictEqual(resCreateRoutine.statusCode, 201);
    const routine = JSON.parse(resCreateRoutine.body);
    assert.ok(routine.routineId.startsWith('routine_'));
    assert.strictEqual(routine.name, 'Hourly Security Audit');
    assert.strictEqual(routine.isEnabled, true);

    // 2. GET /api/routines
    const reqListRoutines = new MockIncomingMessage('GET', '/api/routines');
    const resListRoutines = new MockServerResponse();
    await (server as any).handleRequest(reqListRoutines, resListRoutines);
    assert.strictEqual(resListRoutines.statusCode, 200);
    const routineList = JSON.parse(resListRoutines.body);
    assert.strictEqual(routineList.length, 1);
    assert.strictEqual(routineList[0].routineId, routine.routineId);

    // 3. POST /api/routines/:id/trigger
    const reqTrigger = new MockIncomingMessage('POST', `/api/routines/${routine.routineId}/trigger`);
    const resTrigger = new MockServerResponse();
    await (server as any).handleRequest(reqTrigger, resTrigger);
    assert.strictEqual(resTrigger.statusCode, 200);
    const triggerRes = JSON.parse(resTrigger.body);
    assert.strictEqual(triggerRes.status, 'success');
    assert.strictEqual(triggerRes.routine.runCount, 1);

    // 4. GET /api/routines/:id/logs
    const reqLogs = new MockIncomingMessage('GET', `/api/routines/${routine.routineId}/logs`);
    const resLogs = new MockServerResponse();
    await (server as any).handleRequest(reqLogs, resLogs);
    assert.strictEqual(resLogs.statusCode, 200);
    const logs = JSON.parse(resLogs.body);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].status, 'success');

    // 5. PATCH /api/routines/:id/enabled
    const reqToggle = new MockIncomingMessage('PATCH', `/api/routines/${routine.routineId}/enabled`);
    const resToggle = new MockServerResponse();
    const togglePromise = (server as any).handleRequest(reqToggle, resToggle);
    reqToggle.emit('data', Buffer.from(JSON.stringify({ isEnabled: false })));
    reqToggle.emit('end');
    await togglePromise;
    assert.strictEqual(resToggle.statusCode, 200);
    const toggled = JSON.parse(resToggle.body);
    assert.strictEqual(toggled.isEnabled, false);

    // 6. DELETE /api/routines/:id
    const reqDelRoutine = new MockIncomingMessage('DELETE', `/api/routines/${routine.routineId}`);
    const resDelRoutine = new MockServerResponse();
    await (server as any).handleRequest(reqDelRoutine, resDelRoutine);
    assert.strictEqual(resDelRoutine.statusCode, 200);
    assert.strictEqual(JSON.parse(resDelRoutine.body).success, true);

    // 7. POST /api/rooms
    const reqCreateRoom = new MockIncomingMessage('POST', '/api/rooms');
    const resCreateRoom = new MockServerResponse();
    const createRoomPromise = (server as any).handleRequest(reqCreateRoom, resCreateRoom);
    reqCreateRoom.emit('data', Buffer.from(JSON.stringify({
      name: 'Advisory Panel',
      description: 'Reviews major releases',
      memberAgentIds: ['agent_alpha', 'agent_beta'],
    })));
    reqCreateRoom.emit('end');
    await createRoomPromise;
    assert.strictEqual(resCreateRoom.statusCode, 201);
    const room = JSON.parse(resCreateRoom.body);
    assert.ok(room.roomId.startsWith('room_'));
    assert.strictEqual(room.name, 'Advisory Panel');
    assert.strictEqual(room.memberAgentIds.length, 2);

    // 8. GET /api/rooms
    const reqListRooms = new MockIncomingMessage('GET', '/api/rooms');
    const resListRooms = new MockServerResponse();
    await (server as any).handleRequest(reqListRooms, resListRooms);
    assert.strictEqual(resListRooms.statusCode, 200);
    const roomList = JSON.parse(resListRooms.body);
    assert.strictEqual(roomList.length, 1);
    assert.strictEqual(roomList[0].roomId, room.roomId);

    // 9. GET /api/rooms/:id
    const reqGetRoom = new MockIncomingMessage('GET', `/api/rooms/${room.roomId}`);
    const resGetRoom = new MockServerResponse();
    await (server as any).handleRequest(reqGetRoom, resGetRoom);
    assert.strictEqual(resGetRoom.statusCode, 200);
    assert.strictEqual(JSON.parse(resGetRoom.body).name, 'Advisory Panel');

    // 10. PUT /api/rooms/:id/members
    const reqSetMembers = new MockIncomingMessage('PUT', `/api/rooms/${room.roomId}/members`);
    const resSetMembers = new MockServerResponse();
    const setMembersPromise = (server as any).handleRequest(reqSetMembers, resSetMembers);
    reqSetMembers.emit('data', Buffer.from(JSON.stringify({
      memberAgentIds: ['agent_alpha', 'agent_beta', 'agent_gamma'],
    })));
    reqSetMembers.emit('end');
    await setMembersPromise;
    assert.strictEqual(resSetMembers.statusCode, 200);
    assert.strictEqual(JSON.parse(resSetMembers.body).memberAgentIds.length, 3);

    // 11. POST /api/rooms/:id/discuss
    const reqDiscuss = new MockIncomingMessage('POST', `/api/rooms/${room.roomId}/discuss`);
    const resDiscuss = new MockServerResponse();
    const discussPromise = (server as any).handleRequest(reqDiscuss, resDiscuss);
    reqDiscuss.emit('data', Buffer.from(JSON.stringify({
      topic: 'Evaluate Production Deployment of v1.0',
    })));
    reqDiscuss.emit('end');
    await discussPromise;
    assert.strictEqual(resDiscuss.statusCode, 200);
    const discResult = JSON.parse(resDiscuss.body);
    assert.strictEqual(discResult.turns.length, 3);
    assert.ok(discResult.consensus.includes('CONSENSUS_APPROVED'));

    // 12. DELETE /api/rooms/:id
    const reqDelRoom = new MockIncomingMessage('DELETE', `/api/rooms/${room.roomId}`);
    const resDelRoom = new MockServerResponse();
    await (server as any).handleRequest(reqDelRoom, resDelRoom);
    assert.strictEqual(resDelRoom.statusCode, 200);
    assert.strictEqual(JSON.parse(resDelRoom.body).success, true);
  } finally {
    server.getBridge().routineEngine.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
