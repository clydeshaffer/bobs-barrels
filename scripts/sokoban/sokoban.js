const fs = require("fs");
const xml2js = require("xml2js");
const zlib = require("zlib");

const BANK_SIZE = 16384;

// ids for the password check
const passwordCharMap = new Map([
  ['l', 64],
  ['r', 72],
  ['u', 80],
  ['d', 88],
  ['a', 96],
  ['b', 104],
  ['c', 112],
  ['s', 120],
]);

const CHAR_0 = 168;
const CHAR_1 = 169;
const CHAR_2 = 170;
const CHAR_3 = 171;
const CHAR_4 = 172;
const CHAR_5 = 173;
const CHAR_6 = 174;
const CHAR_7 = 175;
const CHAR_8 = 184;
const CHAR_9 = 185;

const CHAR_LEFT = 200;
const CHAR_RIGHT = 201;
const CHAR_UP = 202;
const CHAR_DOWN = 203;
const CHAR_A = 204;
const CHAR_B = 205;
const CHAR_C = 206;
const CHAR_START = 207;

const TILE_GRASS = 0;
const PLAYER_START = 32;
const PLAYER_GOAL_START = 24;
const TILE_GOAL = 16;
const TILE_BARREL = 252;
const TILE_GOAL_BARREL = 253;
const TILE_WALL = 166;

const parser = new xml2js.Parser();

const argv = require("minimist")(process.argv.slice(2));

if (argv._.length != 3)
  throw new Error(`Expected 3 command line arguments but received ${argv.length}`);

const [inFileName, mapOutputFile, passwordOutputFile] = argv._;

function writeLevelNumber(targetStr, srcStr) {
  const header = targetStr.slice(0, -(16 + srcStr.length));
  const footer = targetStr.slice(-16);
  return header + srcStr + footer;
}

const range = (n) => Array(n).keys();

const getTileFromChar = (c) => {
  switch (c) {
    case "@":
    case "p":
      return PLAYER_START;
    case "#":
      return TILE_WALL;
    case ".":
      return TILE_GOAL;
    case "$":
      return TILE_BARREL;
    case "B":
    case "*":
      return TILE_GOAL_BARREL;
    case "P":
    case "+":
      return PLAYER_GOAL_START;
    case "0":
      return CHAR_0;
    case "1":
      return CHAR_1;
    case "2":
      return CHAR_2;
    case "3":
      return CHAR_3;
    case "4":
      return CHAR_4;
    case "5":
      return CHAR_5;
    case "6":
      return CHAR_6;
    case "7":
      return CHAR_7;
    case "8":
      return CHAR_8;
    case "9":
      return CHAR_9;
    case "l":
        return CHAR_LEFT;
    case "r":
        return CHAR_RIGHT;
    case "u":
        return CHAR_UP;
    case "d":
        return CHAR_DOWN;
    case "a":
        return CHAR_A;
    case "b":
        return CHAR_B;
    case "c":
        return CHAR_C;
    case "s":
        return CHAR_START;
    case " ":
      return TILE_GRASS;
    default:
      throw new Error(`unexpected tile: ${c}`);
  }
};

function prepareLevel(levelNum, level) {
  const widthDiff = 16 - level.$.Width;
  const heightDiff = 16 - level.$.Height;
  const leftPad = Math.floor(widthDiff / 2);

  const padStringLeft = "".padStart(leftPad, " ");

  const topPad = Math.floor(heightDiff / 2);

  const paddedLevel = [
    ...Array.from(range(topPad)).map(() => " ".repeat(16)),
    ...level.L.map((row) => (padStringLeft + row).padEnd(16)),
    ...Array.from(range(heightDiff - topPad)).map(() => " ".repeat(16)),
  ].join("");

  const levelWithNumber = writeLevelNumber(
    paddedLevel,
    (levelNum + 1).toString()
  );

  return levelWithNumber;
}

function convertLevel(level) {
  const levelBuf = Buffer.alloc(256);

  if (level.length != 256)
    throw new Error(`Unexpected level size ${level.length}, expected 256`);

  for (const [ix, c] of level.split('').entries()) {
    levelBuf.writeUint8(getTileFromChar(c), ix);
  }

  return levelBuf;
}

function compressLevel(level) {
  const sizeBuf = Buffer.alloc(1);
  const compressed = zlib.deflateRawSync(level);
  sizeBuf.writeUint8(compressed.length, 0);
  console.log(level.length + " -> " + compressed.length);

  return [sizeBuf, compressed];
}

// NOTE levels is a bit of a heterogenous array
// the even numbered elements describe the size of the odd numbered elements
function truncateLevels(levels, maxSize) {
  let bytesRemaining = maxSize;
  let ret = [];

  for (let i = 0; i < levels.length / 2; i++) {
    // NOTE +1 is because the size buffer itself one byte
    const levelSize = levels[i * 2][0] + 1;

    if (levelSize > bytesRemaining) {
      return ret;
    }

    bytesRemaining -= levelSize;

    ret.push(levels[i * 2]);
    ret.push(levels[i * 2 + 1]);
  }

  return ret;
}

function levelSizes(compressedLevels) {
  const ret = [];

  for (let i = 0; i < compressedLevels.length; i+=2) {
    ret.push(compressedLevels[i].byteLength + compressedLevels[i + 1].byteLength);
  }

  return ret;
}

function runningSum(arr) {
  const ret = [];
  let runningSum = 0;

  for (const a of arr) {
    runningSum += a;
    ret.push(runningSum);
  }

  return ret;
}

function preparePasswords(passwordsByLevel, levelByteIndicies) {
  function passwordStringToIds(password) {
    return password.split('').map(c => {
      if (!passwordCharMap.has(c))
        throw new Error(`Unexpected char '${c}' in password. Expected one of 'lrudabcs'.`);

      return passwordCharMap.get(c);
    });
  }

  // First byte stores the number of password entries
  const ret = [passwordsByLevel.length];

  for (const [levelNum, password] of passwordsByLevel) {
    jumpTarget = levelByteIndicies[levelNum - 1];
    jumpHighByte = (jumpTarget & 0xFF00) >> 8;
    jumpLowByte = jumpTarget & 0xFF;

    ret.push([...passwordStringToIds(password), jumpLowByte, jumpHighByte]);
  }

  return ret.flat();
}

fs.readFile(inFileName, function (_err, data) {
  parser.parseString(data, (_xmlErr, jsonObj) => {
    const levels = jsonObj.SokobanLevels.LevelCollection.flatMap(
      (col) => col.Level
    );

    const reasonablySizedLevels = levels.filter((level) => level.$.Width <= 16 && level.$.Height <= 14);

    const passwordLevels = Array.from(reasonablySizedLevels.entries())
          .filter(([levelNum, level]) => level.$.Password)
          .map(([levelNum, level]) => [levelNum, level.$.Password]);

    const convertedLevels = Array.from(reasonablySizedLevels.entries())
          .map(([levelNum, level]) => prepareLevel(levelNum, level))
          .map(level => convertLevel(level));

    let compressedLevels = convertedLevels.flatMap(compressLevel);
    let bufToWrite = Buffer.concat(compressedLevels);

    // TODO account for the password jump entries in this size calculation
    if (bufToWrite.byteLength > BANK_SIZE) {
      console.warn("levels too big, truncating");

      compressedLevels = truncateLevels(compressedLevels, BANK_SIZE);
      bufToWrite = Buffer.concat(compressedLevels);
    }

    fs.writeFileSync(mapOutputFile, bufToWrite);

    console.log(
      `wrote ${compressedLevels.length / 2} levels (${
        bufToWrite.byteLength
      } bytes) to ${mapOutputFile}`
    );

    const passwordJumpData = preparePasswords(passwordLevels, runningSum(levelSizes(compressedLevels)));

    fs.writeFileSync(passwordOutputFile, new Uint8Array(passwordJumpData));

    console.log(
      `wrote ${passwordLevels.length} password jump entries (${
        passwordJumpData.length
      } bytes) to ${passwordOutputFile}`
    );
  });
});
