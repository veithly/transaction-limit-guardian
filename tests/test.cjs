const Web3 = require('@artela/web3');
const fs = require('fs');
const { expect } = require('chai');

const privateKey = fs.readFileSync('../privateKey.txt', "utf-8").toString().trim();

describe('TransactionLimitGuardianAspect', function () {
  let web3;
  let aspect;
  let myToken;
  let owner;
  let addr1;
  let addr2;
  let aspectCore;

  const initialSupply = '1000000000000000000000000'; // 1,000,000 tokens
  const dailyLimit = '1000000000000000000000'; // 1,000 tokens

  before(async function () {
    web3 = new Web3('https://betanet-rpc1.artela.network');

    // 获取账户
    [owner, addr1, addr2] = await web3.eth.getAccounts();

    // 部署 MyToken 合约
    const MyToken = new web3.eth.Contract(JSON.parse(fs.readFileSync('../contracts/MyToken.sol/MyToken.json').toString()).abi);
    myToken = await MyToken.deploy({
      data: JSON.parse(fs.readFileSync('../contracts/MyToken.sol/MyToken.json').toString()).bytecode,
      arguments: [initialSupply]
    }).send({ from: owner, gas: 3000000 });

    // 部署 Aspect
    const aspectBytecode = fs.readFileSync('./build/release.wasm', {encoding: "hex"});
    aspect = new web3.atl.Aspect();
    const deploy = await aspect.deploy({
      data: '0x' + aspectBytecode,
      properties: [
        { 'key': 'owner', 'value': owner }
      ],
      joinPoints: ["PreContractCall", "PostContractCall"]
    });

    aspectCore = web3.atl.aspectCore();
    const tx = {
      from: owner,
      data: deploy.encodeABI(),
      to: aspectCore.options.address,
      gas: 3000000
    };
    const signedTx = await web3.eth.accounts.signTransaction(tx, privateKey);
    const aspectReceipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);

    // 绑定 Aspect 到合约
    const bind = await myToken.methods.bind({
      priority: 1,
      aspectId: aspectReceipt.options.address,
      aspectVersion: 1,
    });

    const bindTx = {
      from: owner,
      data: bind.encodeABI(),
      to: aspectCore.options.address,
      gas: 3000000
    };
    const signedBindTx = await web3.eth.accounts.signTransaction(bindTx, privateKey);
    await web3.eth.sendSignedTransaction(signedBindTx.rawTransaction);

    // 设置每日限额
    const setLimitData = web3.eth.abi.encodeFunctionCall({
      name: 'operation',
      type: 'function',
      inputs: [{
        type: 'bytes',
        name: 'data'
      }]
    }, [web3.utils.toHex('0001' + addr1 + ',' + myToken.options.address + ',' + dailyLimit)]);

    const setLimitTx = {
      from: owner,
      to: aspectReceipt.options.address,
      data: setLimitData,
      gas: 3000000
    };
    const signedSetLimitTx = await web3.eth.accounts.signTransaction(setLimitTx, privateKey);
    await web3.eth.sendSignedTransaction(signedSetLimitTx.rawTransaction);
  });

  it('Should allow transfers within the daily limit', async function () {
    const amount = '500000000000000000000'; // 500 tokens
    await myToken.methods.transfer(addr1, amount).send({ from: owner });
    const balance = await myToken.methods.balanceOf(addr1).call();
    expect(balance).to.equal(amount);
  });

  it('Should revert transfers exceeding the daily limit', async function () {
    const amount = '1500000000000000000000'; // 1500 tokens
    try {
      await myToken.methods.transfer(addr1, amount).send({ from: owner });
      expect.fail('Expected an error');
    } catch (error) {
      expect(error.message).to.include('Daily limit exceeded');
    }
  });

  it('Should reset the daily limit after 24 hours', async function () {
    const amount = '500000000000000000000'; // 500 tokens
    await myToken.methods.transfer(addr1, amount).send({ from: owner });

    // Simulate 24 hours passing
    await web3.currentProvider.send({
      jsonrpc: '2.0',
      method: 'evm_increaseTime',
      params: [24 * 60 * 60],
      id: new Date().getTime()
    }, () => {});

    // This should now succeed
    await myToken.methods.transfer(addr1, amount).send({ from: owner });
    const balance = await myToken.methods.balanceOf(addr1).call();
    expect(balance).to.equal('1000000000000000000000'); // 1000 tokens
  });

  it('Should allow emergency unlock', async function () {
    const amount = '1500000000000000000000'; // 1500 tokens

    // Set emergency unlock for 1 hour
    const unlockData = web3.eth.abi.encodeFunctionCall({
      name: 'operation',
      type: 'function',
      inputs: [{
        type: 'bytes',
        name: 'data'
      }]
    }, [web3.utils.toHex('0002' + addr1 + ',3600')]);

    const unlockTx = {
      from: owner,
      to: aspect.options.address,
      data: unlockData,
      gas: 3000000
    };
    const signedUnlockTx = await web3.eth.accounts.signTransaction(unlockTx, privateKey);
    await web3.eth.sendSignedTransaction(signedUnlockTx.rawTransaction);

    // This should now succeed despite exceeding the daily limit
    await myToken.methods.transfer(addr1, amount).send({ from: owner });
    const balance = await myToken.methods.balanceOf(addr1).call();
    expect(balance).to.equal(amount);
  });

  it('Should log transactions', async function () {
    const amount = '500000000000000000000'; // 500 tokens
    await myToken.methods.transfer(addr1, amount).send({ from: owner });

    // Get transaction log
    const logData = web3.eth.abi.encodeFunctionCall({
      name: 'operation',
      type: 'function',
      inputs: [{
        type: 'bytes',
        name: 'data'
      }]
    }, [web3.utils.toHex('0003' + addr1)]);

    const logTx = {
      from: owner,
      to: aspect.options.address,
      data: logData,
    };

    const log = await web3.eth.call(logTx);

    // Parse and check the log
    const decodedLog = web3.utils.hexToUtf8(log);
    const logEntries = decodedLog.split('|');
    expect(logEntries.length).to.equal(1);
    const [timestamp, loggedAmount, tokenAddress] = logEntries[0].split(',');
    expect(web3.utils.toBN(loggedAmount)).to.be.bignumber.equal(web3.utils.toBN(amount));
    expect(tokenAddress).to.equal(myToken.options.address);
  });
});
