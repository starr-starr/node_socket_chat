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
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_offset TEXT UNIQUE,
      content TEXT
    );
  `);

  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    connectionStateRecovery: {},// 此功能将临时存储服务器发送的所有事件，并在客户端重新连接时尝试恢复客户端的状态：
    adapter: createAdapter()  // 集群适配器，用于在不同进程之间共享 WebSocket 连接的状态，从而实现多进程间的实时通信。

  });
  //  SSR 服务端渲染
  const __dirname = dirname(fileURLToPath(import.meta.url));

  app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'index.html'));
  });

  io.on('connection', async (socket) => {
    socket.on('chat message', async (msg, clientOffset, callback) => {
      let result;
      // 将发送的所有消息保存至数据库
      try {
        result = await db.run('INSERT INTO messages (content, client_offset) VALUES (?, ?)', msg, clientOffset);
      } catch (e) {
        if (e.errno === 19 /* SQLITE_CONSTRAINT */ ) {
          callback();
        } else {
          // nothing to do, just let the client retry
        }
        return;
      }
      // 广播至频道
      io.emit('chat message', msg, result.lastID);
      callback();
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
    if (!socket.recovered) {
      try {
        await db.each('SELECT id, content FROM messages WHERE id > ?',
            //  socket.handshake.auth.serverOffset 是为了处理客户端手动设置了一个非零的偏移量
          [socket.handshake.auth.serverOffset || 0], 
          (_err, row) => {
            socket.emit('chat message', row.content, row.id);
          }
        )
      } catch (e) {
        // something went wrong
      }
    }
  });

  const port = process.env.PORT;

  server.listen(port, () => {
    console.log(`server running at http://localhost:${port}`);
  });
}