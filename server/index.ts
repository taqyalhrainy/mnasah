import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'POST'],
  },
});

const PORT = Number(process.env.PORT ?? 4000);

app.get('/health', (_request, response) => {
  response.json({ ok: true, service: 'mansah-signaling' });
});

io.on('connection', (socket) => {
  socket.on('room:join', ({ roomId, role }: { roomId: string; role: string }) => {
    socket.join(roomId);
    socket.to(roomId).emit('peer:joined', { peerId: socket.id, role });
  });

  socket.on('webrtc:offer', ({ roomId, offer }) => {
    socket.to(roomId).emit('webrtc:offer', { offer, from: socket.id });
  });

  socket.on('webrtc:answer', ({ roomId, answer }) => {
    socket.to(roomId).emit('webrtc:answer', { answer, from: socket.id });
  });

  socket.on('webrtc:ice-candidate', ({ roomId, candidate }) => {
    socket.to(roomId).emit('webrtc:ice-candidate', { candidate, from: socket.id });
  });

  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (roomId !== socket.id) {
        socket.to(roomId).emit('peer:left', { peerId: socket.id });
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Mansah signaling server running on http://localhost:${PORT}`);
});
