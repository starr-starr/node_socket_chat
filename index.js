import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { availableParallelism } from 'node:os';
import cluster from 'node:cluster';
import { createAdapter, setupPrimary } from '@socket.io/cluster-adapter';

/* - 判断是否主进程
    - 是则 fork 子进程，创立更多进程
    - 否则启动 server
*/
if (cluster.isPrimary) {
  // cluster 可以通过一个父进程管理一坨子进程的方式来实现集群
  const numCPUs = availableParallelism();
  for (let i = 0; i < numCPUs; i++) {
    // 获取 CPU 个数来开启进程
    cluster.fork({
      PORT: 3000 + i
    });
  }
  // 建立进程之间的连接
  setupPrimary();
} else {
  const db = await open({
    filename: 'chat.db',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      room_id INTEGER,
      socket_id TEXT,
      status INTEGER DEFAULT 0
    );
  
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      content TEXT,
      room_id INTEGER,
      client_offset TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE
    );    
  `);

  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    cors: true,//允许跨域
    connectionStateRecovery: {},// 此功能将临时存储服务器发送的所有事件，并在客户端重新连接时尝试恢复客户端的状态：
    adapter: createAdapter()  // 集群适配器，用于在不同进程之间共享 WebSocket 连接的状态，从而实现多进程间的实时通信。
  });
  //  SSR 服务端渲染
  const __dirname = dirname(fileURLToPath(import.meta.url));

  app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'index.html'));
  });
  // - 查询现在已有房间数以及该房间内在线人数
  async function getRoomUsers() {
    const query = `
        SELECT rooms.name AS room_name, users.name AS user_name, users.status
        FROM rooms
        LEFT JOIN users ON rooms.id = users.room_id
    `;
    return await db.all(query);
  }
  // 更新 groupList
  async function updateGroupList() {
    // 获取房间用户列表并更新 groupList
    const roomUsers = await getRoomUsers();
    const groupList = {};

    roomUsers.forEach(({ room_name, user_name, status }) => {
      if (!groupList[room_name]) {
        groupList[room_name] = [];
      }
      if (user_name) {
        groupList[room_name].push({ name: user_name, status: status });
      }
    });

    // 将对象转换为数组形式
    const groupListArray = Object.keys(groupList).map(roomName => ({ [roomName]: groupList[roomName] }));
    return groupListArray;
  }

  async function findSocketByUsername(username) {
    const query = `SELECT socket_id FROM users WHERE name = ? LIMIT 1`;
    return await db.get(query, username);
  }

  async function getAllUsers() {
    const query = `
      SELECT name, status FROM users
    `;
    return await db.all(query);
  }

  io.on('connection', async (socket) => {
    let save_name, save_room
    socket.on('join', async (name, room) => {
      console.log(`join 触发`);
      save_name = name;
      save_room = room;
      // 检查房间是否已存在
      const existingRoom = await db.get('SELECT id FROM rooms WHERE name = ? LIMIT 1', room);
      if (!existingRoom) {
        // 如果房间不存在，则插入新房间
        await db.run('INSERT INTO rooms (name) VALUES (?)', room);
      }
      socket.join(room);
      // 检查用户是否已存在
      const existingUser = await db.get('SELECT id FROM users WHERE name = ? LIMIT 1', name);
      if (!existingUser) {
        // 如果用户不存在，则插入新用户
        await db.run('INSERT INTO users (name, room_id, socket_id, status) VALUES (?, (SELECT id FROM rooms WHERE name = ?),?, ?)', name, room, socket.id, 1);
      } else {
        // 如果用户已存在，则更新用户所在的房间以及 socket_id
        await db.run('UPDATE users SET room_id = (SELECT id FROM rooms WHERE name = ?),socket_id = ?,status = ? WHERE name = ?', room, socket.id, 1, name);
      }

      const groupListArray = await updateGroupList();

      // 发送给客户端
      socket.emit('groupList', groupListArray);
      socket.broadcast.emit('groupList', groupListArray);
      // 用户加入更新在线人数
      const allUsers = await getAllUsers();
      // 将所有用户列表发送回客户端
      socket.emit('user_List', allUsers);
      socket.broadcast.emit('user_List', allUsers);
      // 发送加入房间的消息
      socket.emit('message', { user: '管理员', text: `${name}进入了房间` });
      socket.to(room).emit('message', { user: '管理员', text: `${name}进入了房间` });
    });
    socket.on('chat message', async (name, room, msg, clientOffset) => {
      let result;
      // 将发送的所有消息保存至数据库 
      try {
        // 插入消息
        result = await db.run('INSERT INTO messages (user_id, content, room_id, client_offset) VALUES ((SELECT id FROM users WHERE name = ?), ?, (SELECT id FROM rooms WHERE name = ?), ?)', name, msg, room, clientOffset);

      } catch (e) {
        if (e.errno === 19 /* SQLITE_CONSTRAINT */) {
          // callback();
          console.log("DataBase error")
        } else {
          // nothing to do, just let the client retry
        }
        return;
      }
      // 广播至频道
      socket.to(room).emit('chat message', { user: name, text: msg }, result.lastID);
    });
    socket.on('typing', (name, room, isTyping) => {
      if (isTyping) {
        socket.to(room).emit('user typing', name);
      } else {
        socket.to(room).emit('clear typing');
      }
    });
    socket.on('disconnect', async () => {
      // 更新用户状态
      await db.run('UPDATE users SET status = 0 WHERE socket_id = ?', socket.id);

      const groupListArray = await updateGroupList();
      // 发送给客户端
      socket.emit('groupList', groupListArray);
      socket.broadcast.emit('groupList', groupListArray);

      // 发送离开房间的消息
      socket.emit('message', { user: '管理员', text: `${save_name}离开了房间` });
      socket.to(save_room).emit('message', { user: '管理员', text: `${save_name}离开了房间` });
    })
    socket.on('private message', async (targetUsername, message) => {
      console.log(targetUsername,message)
      // 找到目标用户的 socket
      const { socket_id } = await findSocketByUsername(targetUsername);
      if (socket_id) {
        // 发送私聊消息给目标用户
        console.log(socket_id)
        socket.to(socket_id).emit('private message', save_name, message);
      } else {
        // 如果目标用户不在线，可以选择处理或者忽略
        console.log(`${targetUsername} 不在线`);
      }
    });
    // socket.on("private message", (name, msg) => {
    //   const anotherSocketId = name;
    //   socket.to(anotherSocketId).emit("private message", socket.id, msg);
    // });
    /* -如果断联，再次连接时得到 id > serverOffset 的记录
       - id 为数据库的自增主键，serverOffset 为各个进程的 id_clientOffset 偏移量
       - example :
         -  1 process1 || 2 process2
                  开始聊天
         -  1:hello 
         -  2:hello
         -  1 断联
         -  此时数据库中   
            - process1 : id_clientOffset = process1_0
            - process2 : id_clientOffset = process2_0 
         -  2:hi
         -  2:nice
         -  此时数据库中   
            - process1 : id_clientOffset = process1_0
            - process2 : id_clientOffset = process2_2
         -  1 重连
         - process1 查询 id > 0 的所有 content  
    */
    // if (!socket.recovered) {
    //   try {
    //     await db.each('SELECT id, content FROM messages WHERE id > ?',
    //       //  socket.handshake.auth.serverOffset 是为了处理客户端手动设置了一个非零的偏移量
    //       [socket.handshake.auth.serverOffset || 0],
    //       (_err, row) => {
    //         socket.emit('chat message', row.content, row.id);
    //       }
    //     )
    //   } catch (e) {
    //     // something went wrong
    //   }
    // }
  });

  const port = process.env.PORT;

  server.listen(port, () => {
    console.log(`server running at http://localhost:${port}`);
  });
}
