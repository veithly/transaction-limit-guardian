import {
  allocate,
  entryPoint,
  execute,
  IPreContractCallJP,
  PreContractCallInput,
  IAspectOperation,
  OperationInput,
  sys,
  uint8ArrayToHex,
  hexToUint8Array,
  stringToUint8Array,
  uint8ArrayToString,
} from "@artela/aspect-libs";

class TransactionLimitGuardianAspect implements IPreContractCallJP, IAspectOperation {
  private readonly DAILY_LIMIT_KEY: string = "daily_limit";
  private readonly DAILY_SPENT_KEY: string = "daily_spent";
  private readonly LAST_RESET_KEY: string = "last_reset";
  private readonly EMERGENCY_UNLOCK_KEY: string = "emergency_unlock";
  private readonly TRANSACTION_LOG_KEY: string = "transaction_log";

  isOwner(sender: Uint8Array): bool {
    // Implement proper ownership check
    return true;
  }

  preContractCall(input: PreContractCallInput): void {
    const amount = this.parseAmount(input.call!.data);
    const from = uint8ArrayToHex(input.call!.from);
    const tokenType = this.parseTokenType(input.call!.data);

    this.checkAndUpdateDailyLimit(from, amount, tokenType);
    this.logTransaction(from, amount, tokenType);
  }

  operation(input: OperationInput): Uint8Array {
    const op = this.parseOP(uint8ArrayToHex(input.callData));
    const params = this.parsePrams(uint8ArrayToHex(input.callData));

    switch (op) {
      case 1: // Set daily limit
        return this.setDailyLimit(params);
      case 2: // Emergency unlock
        return this.emergencyUnlock(params);
      case 3: // Get transaction log
        return this.getTransactionLog(params);
      default:
        sys.revert("Unknown operation");
        return new Uint8Array(0);
    }
  }

  private checkAndUpdateDailyLimit(address: string, amount: i64, tokenType: string): void {
    if (this.isEmergencyUnlocked(address)) {
      return; // Skip limit check if emergency unlocked
    }

    const currentTime = this.getCurrentTime();
    const lastResetTime = this.getStorageI64(`${address}:${tokenType}:${this.LAST_RESET_KEY}`);

    if (this.isNewDay(currentTime, lastResetTime)) {
      this.resetDailySpent(address, currentTime, tokenType);
    }

    const dailyLimit = this.getStorageI64(`${address}:${tokenType}:${this.DAILY_LIMIT_KEY}`);
    const dailySpent = this.getStorageI64(`${address}:${tokenType}:${this.DAILY_SPENT_KEY}`);

    if (dailySpent + amount > dailyLimit) {
      sys.revert("Daily limit exceeded");
    }

    this.setStorageI64(`${address}:${tokenType}:${this.DAILY_SPENT_KEY}`, dailySpent + amount);
  }

  private setDailyLimit(params: string): Uint8Array {
    const paramsArray = params.split(',');
    if (paramsArray.length !== 3) {
      sys.revert("Invalid parameters for setDailyLimit");
      return new Uint8Array(0);
    }
    const address = paramsArray[0];
    const tokenType = paramsArray[1];
    const limitStr = paramsArray[2];
    const limit = i64.parse(limitStr);
    this.setStorageI64(`${address}:${tokenType}:${this.DAILY_LIMIT_KEY}`, limit);
    return new Uint8Array(0);
  }

  private emergencyUnlock(params: string): Uint8Array {
    const paramsArray = params.split(',');
    if (paramsArray.length !== 2) {
      sys.revert("Invalid parameters for emergencyUnlock");
      return new Uint8Array(0);
    }
    const address = paramsArray[0];
    const durationStr = paramsArray[1];
    const duration = i64.parse(durationStr);
    const unlockUntil = this.getCurrentTime() + duration;
    this.setStorageI64(`${address}:${this.EMERGENCY_UNLOCK_KEY}`, unlockUntil);
    return new Uint8Array(0);
  }

  private isEmergencyUnlocked(address: string): bool {
    const unlockUntil = this.getStorageI64(`${address}:${this.EMERGENCY_UNLOCK_KEY}`);
    return this.getCurrentTime() < unlockUntil;
  }

  private logTransaction(address: string, amount: i64, tokenType: string): void {
    const currentTime = this.getCurrentTime();
    const logEntry = `${currentTime},${amount},${tokenType}`;
    const currentLog = this.getStorage(`${address}:${this.TRANSACTION_LOG_KEY}`);
    const updatedLog = currentLog ? currentLog + '|' + logEntry : logEntry;
    this.setStorage(`${address}:${this.TRANSACTION_LOG_KEY}`, updatedLog);
  }

  private getTransactionLog(params: string): Uint8Array {
    const address = params;
    const log = this.getStorage(`${address}:${this.TRANSACTION_LOG_KEY}`);
    return stringToUint8Array(log || "");
  }

  private getCurrentTime(): i64 {
    const currentTimeBytes = sys.hostApi.runtimeContext.get('block.timestamp');
    return i64.parse(uint8ArrayToHex(currentTimeBytes), 16);
  }

  private isNewDay(currentTime: i64, lastResetTime: i64): bool {
    return currentTime - lastResetTime >= 86400; // 24 hours in seconds
  }

  private resetDailySpent(address: string, currentTime: i64, tokenType: string): void {
    this.setStorageI64(`${address}:${tokenType}:${this.DAILY_SPENT_KEY}`, 0);
    this.setStorageI64(`${address}:${tokenType}:${this.LAST_RESET_KEY}`, currentTime);
  }

  private getStorageI64(key: string): i64 {
    const value = sys.aspect.mutableState.get<Uint8Array>(key);
    return value.unwrap().byteLength > 0 ? i64.parse(uint8ArrayToHex(value.unwrap()), 16) : 0;
  }

  private setStorageI64(key: string, value: i64): void {
    const hexValue = value.toString(16).padStart(16, '0');
    sys.aspect.mutableState.get<Uint8Array>(key).set(hexToUint8Array(hexValue));
  }

  private getStorage(key: string): string {
    const value = sys.aspect.mutableState.get<Uint8Array>(key);
    return value.unwrap().byteLength > 0 ? uint8ArrayToString(value.unwrap()) : "";
  }

  private setStorage(key: string, value: string): void {
    sys.aspect.mutableState.get<Uint8Array>(key).set(stringToUint8Array(value));
  }

  private parseAmount(data: Uint8Array): i64 {
    // Simplified implementation, assumes amount is at a specific position in calldata
    return i64.parse(uint8ArrayToHex(data.slice(36, 68)), 16);
  }

  private parseTokenType(data: Uint8Array): string {
    // Simplified implementation, assumes token type can be derived from calldata
    // You may need to adjust this based on your specific contract and token implementation
    return uint8ArrayToHex(data.slice(4, 24));
  }

  private parseOP(callData: string): u32 {
    const opHex = callData.startsWith('0x') ? callData.substring(2, 6) : callData.substring(0, 4);
    return u32.parse(opHex, 16);
  }

  private parsePrams(callData: string): string {
    return callData.startsWith('0x') ? callData.substring(6) : callData.substring(4);
  }
}

// Register Aspect instance
const aspect = new TransactionLimitGuardianAspect();
entryPoint.setAspect(aspect);
entryPoint.setOperationAspect(aspect);

// Export necessary methods
export { execute, allocate };