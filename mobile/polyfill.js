import { install } from "react-native-quick-crypto";
import { Buffer } from "buffer";

global.Buffer = Buffer;
install();
global.Buffer = Buffer;
