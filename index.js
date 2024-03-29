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
  for (let i = 0; i < 2; i++) {
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
      room_id INTEGER
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
    cors: true ,//允许跨域
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
        SELECT rooms.name AS room_name, users.name AS user_name
        FROM users
        INNER JOIN rooms ON users.room_id = rooms.id
    `;
    return await db.all(query);
  }

  io.on('connection', async (socket) => {
    // - 加入房间
    // - 返回所有房间以及在线人数
    socket.on('join', async (name, room) => {
      console.log(`join 触发`)
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
        await db.run('INSERT INTO users (name, room_id) VALUES (?, (SELECT id FROM rooms WHERE name = ?))', name, room);
      } else {
        // 如果用户已存在，则更新用户所在的房间
        await db.run('UPDATE users SET room_id = (SELECT id FROM rooms WHERE name = ?) WHERE name = ?', room, name);
      }

      // 查询数据库获取每个房间内的用户列表
      const roomUsers = await getRoomUsers();

      // 将房间及其对应用户列表组装成数组形式
      const groupList = {};
      roomUsers.forEach(({ room_name, user_name }) => {
        if (!groupList[room_name]) {
          groupList[room_name] = [];
        }
        groupList[room_name].push(user_name);
      });

      // 将对象转换为数组形式
      const groupListArray = Object.keys(groupList).map(roomName => ({ [roomName]: groupList[roomName] }));
      // 发送给客户端
      socket.emit('groupList', groupListArray);
      socket.broadcast.emit('groupList', groupListArray);
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
      // callback();
    });
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
