import "dotenv/config";
import config from "../config/config";
import { buildServices } from "./application/servicesBuilder";
import cors from "cors";
import { initRoutes } from "./routes";
import { errorHandler } from "./errorHandler";
import express, { NextFunction, Request, Response, Router } from "express";
import { Express } from "express-serve-static-core";
import { chatRoomControllers, userControllers } from "./application/controller";
import { Connection } from "mongoose";
import { IncomingMessage, ServerResponse, createServer } from "http";
import { Server, Socket } from "socket.io";
import jwt, { JwtPayload } from "jsonwebtoken";
import sanitizedConfig from "../config/config";
import * as httpLibrary from "http";

interface CustomSocket extends Socket {
  token: JwtPayload; // Add your custom properties here
}
export type UserRootControllers = {
  handleLogin: (
    req: Request,
    res: Response,
    next: NextFunction
  ) => Promise<Response | undefined>;

  handleGoogleLogin: (req: Request, res: Response, next: NextFunction) => void;

  postUser: (
    req: Request,
    res: Response,
    next: NextFunction
  ) => Promise<Response | undefined>;
};

export type ChatRoomRootControllers = {
  postChatRoom: (
    req: Request,
    res: Response,
    next: NextFunction
  ) => Promise<Response | undefined>;

  getChatRoomList: (
    req: Request,
    res: Response,
    next: NextFunction
  ) => Promise<void>;
};

export class Application {
  server: httpLibrary.Server<typeof IncomingMessage, typeof ServerResponse>;
  connection: Connection;
  constructor(server: httpLibrary.Server, connection: Connection) {
    this.server = server;
    this.connection = connection;
  }

  public stop() {
    this.server.close();
    this.connection.close();
  }
}

export async function applicationStart() {
  const databaseName =
    config.NODE_ENV === "test" ? config.TEST_DATABASE : config.DATABASE;
  return startServer(databaseName);
}

export async function appSetup(app: Express, router: Router) {
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/api", router);
  app.use(
    (
      error: Error,
      _request: Request,
      response: Response,
      next: NextFunction
    ) => {
      errorHandler(error, response, next);
    }
  );
}

class RoomOccupancyMapManager {
  private _map: Map<string, Array<string>>;
  constructor(map: Map<string, Array<string>>) {
    this._map = map;
  }

  addItemToMap(key: string, value: string) {
    const existingArray = this._map.get(key) || [];
    existingArray.push(value);
    this._map.set(key, existingArray);
  }

  deleteItemFromMap(key: string, value: string) {
    const existingArray = this._map.get(key) || [];
    const newArray = existingArray.filter(
      (participant) => participant != value
    );
    this._map.set(key, newArray);
  }

  get map(): Map<string, Array<string>> {
    return this._map;
  }
}


function socketSetup () {

}

async function startServer(databaseName: string) {
  const services = buildServices(databaseName);
  const userRootControllers = userControllers(services.userService);
  const chatRoomRootControllers = chatRoomControllers(services.chatRoomService);
  const app = express();
  const router = express.Router();
  await initRoutes(router, userRootControllers, chatRoomRootControllers);
  await appSetup(app, router);

  const httpServer = createServer(app);
  const roomsMap = new Map<string, Array<string>>();
  const roomsOccupancyMap = new RoomOccupancyMapManager(roomsMap);



  const io = new Server(httpServer, {
    cors: {
      origin: "http://localhost:5173",
    },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    console.log("handshake");
    try {
      const decodedToken = jwt.verify(token, sanitizedConfig.JWT_SECRET, {
        ignoreExpiration: false,
      }) as JwtPayload;

      (socket as CustomSocket).token = decodedToken;
      next();
    } catch (error) {
      if (error === "jwt expired") {
        console.log("jwt expired");
        //next(error)
      }
      console.log("no token or bad token");
      //next(error);
    }
  });

  io.on("connection", (socket) => {
    const nickName = (socket as CustomSocket).token.nickName;
    let room: string | null = null;
    console.log(`⚡: ${nickName} just connected!`);
    io.emit("connected", { socketId: socket.id, nickName: nickName });
    socket.on("messag", (msg) => {
      console.log(msg);
      if (room) {
        io.to(room).emit("messag", {
          nickName: nickName,
          messageId: msg.messageId,
          message: msg.message,
        });
      }
    });

    socket.on("roomAdded", (msg) => {
      console.log(msg);
      io.emit("roomAdded", "roomAdded");
    });

    socket.on("userEntered", (msg) => {
      room = msg.room;
      if (room) {
        socket.join(msg.room);
        roomsOccupancyMap.addItemToMap(room, nickName);
        io.to(room).emit("userEntered", roomsOccupancyMap.map.get(room));
        console.log(roomsOccupancyMap.map);
      }
    });

    socket.on("userLeft", () => {
      if (room) {
        socket.leave(room);
        roomsOccupancyMap.deleteItemFromMap(room, nickName);
        io.emit("userLeft", roomsOccupancyMap.map.get(room));
      }
    });

    socket.on("loggedOut", () => {
      if (room) {
        socket.leave(room);
        roomsOccupancyMap.deleteItemFromMap(room, nickName);
        io.emit("userLeft", roomsOccupancyMap.map.get(room));
      }
    });

    socket.on("disconnect", (reason) => {
      console.log("rroom", room);
      if (room) {
        roomsOccupancyMap.deleteItemFromMap(room, nickName);
        io.emit("userLeft", roomsOccupancyMap.map.get(room));
      }
      console.log(`🔥: ${nickName} disconnected`, reason);
    });
  });

  const server = httpServer.listen(config.PORT, () => {
    console.log(`Server is listening on port ${config.PORT}! 🍄 `);
  });

  return new Application(server, services.connection);
}
