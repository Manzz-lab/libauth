import {
  instantiateSecp256k1,
  instantiateSha256,
  Sha256,
} from '../../crypto/crypto';
import {
  generateSigningSerializationBCH,
  SigningSerializationFlag,
} from '../../vm/instruction-sets/common/signing-serialization';
import {
  AuthenticationProgramStateBCH,
  generateBytecodeMap,
  instantiateVirtualMachineBCH,
  instructionSetBCHCurrentStrict,
  OpcodesBCH,
} from '../../vm/instruction-sets/instruction-sets';
import { compilerCreateStateCommon, createCompiler } from '../compiler';
import {
  attemptCompilerOperations,
  compilerOperationHdKeyPrecomputedSignature,
  compilerOperationHelperDeriveHdKeyPrivate,
  compilerOperationKeyPrecomputedSignature,
  compilerOperationRequires,
} from '../compiler-operation-helpers';
import { compilerOperationsCommon } from '../compiler-operations';
import {
  AnyCompilationEnvironment,
  CompilationData,
  CompilationEnvironment,
  Compiler,
  CompilerOperationDataCommon,
} from '../compiler-types';
import { resolveScriptIdentifier } from '../language/resolve';

export type CompilerOperationsKeyBCH =
  | 'data_signature'
  | 'public_key'
  | 'schnorr_data_signature'
  | 'schnorr_signature'
  | 'signature';

/* eslint-disable camelcase */
export enum SigningSerializationAlgorithmIdentifier {
  /**
   * A.K.A. `SIGHASH_ALL`
   */
  all_outputs = 'all_outputs',
  /**
   * A.K.A. `SIGHASH_ALL|ANYONE_CAN_PAY`
   */
  all_outputs_single_input = 'all_outputs_single_input',
  /**
   * A.K.A. `SIGHASH_SINGLE`
   */
  corresponding_output = 'corresponding_output',
  /**
   * A.K.A. `SIGHASH_SINGLE|ANYONE_CAN_PAY`
   */
  corresponding_output_single_input = 'corresponding_output_single_input',
  /**
   * A.K.A `SIGHASH_NONE`
   */
  no_outputs = 'no_outputs',
  /**
   * A.K.A `SIGHASH_NONE|ANYONE_CAN_PAY`
   */
  no_outputs_single_input = 'no_outputs_single_input',
}
/* eslint-enable camelcase */

// eslint-disable-next-line complexity
const getSigningSerializationType = (
  algorithmIdentifier: string,
  prefix = ''
) => {
  switch (algorithmIdentifier) {
    case `${prefix}${SigningSerializationAlgorithmIdentifier.all_outputs}`:
      return Uint8Array.of(
        // eslint-disable-next-line no-bitwise
        SigningSerializationFlag.all_outputs | SigningSerializationFlag.fork_id
      );
    case `${prefix}${SigningSerializationAlgorithmIdentifier.all_outputs_single_input}`:
      return Uint8Array.of(
        // eslint-disable-next-line no-bitwise
        SigningSerializationFlag.all_outputs |
          SigningSerializationFlag.single_input |
          SigningSerializationFlag.fork_id
      );
    case `${prefix}${SigningSerializationAlgorithmIdentifier.corresponding_output}`:
      return Uint8Array.of(
        // eslint-disable-next-line no-bitwise
        SigningSerializationFlag.corresponding_output |
          SigningSerializationFlag.fork_id
      );
    case `${prefix}${SigningSerializationAlgorithmIdentifier.corresponding_output_single_input}`:
      return Uint8Array.of(
        // eslint-disable-next-line no-bitwise
        SigningSerializationFlag.corresponding_output |
          SigningSerializationFlag.single_input |
          SigningSerializationFlag.fork_id
      );
    case `${prefix}${SigningSerializationAlgorithmIdentifier.no_outputs}`:
      return Uint8Array.of(
        // eslint-disable-next-line no-bitwise
        SigningSerializationFlag.no_outputs | SigningSerializationFlag.fork_id
      );
    case `${prefix}${SigningSerializationAlgorithmIdentifier.no_outputs_single_input}`:
      return Uint8Array.of(
        // eslint-disable-next-line no-bitwise
        SigningSerializationFlag.no_outputs |
          SigningSerializationFlag.single_input |
          SigningSerializationFlag.fork_id
      );
    default:
      return undefined;
  }
};

export const compilerOperationHelperComputeSignatureBCH = ({
  identifier,
  operationData,
  operationName,
  privateKey,
  sha256,
  sign,
}: {
  identifier: string;
  privateKey: Uint8Array;
  operationData: CompilerOperationDataCommon;
  operationName: string;
  sign: (privateKey: Uint8Array, messageHash: Uint8Array) => Uint8Array;
  sha256: { hash: Sha256['hash'] };
}) => {
  const [, , algorithm, unknown] = identifier.split('.');
  if (unknown !== undefined) {
    return `Unknown component in "${identifier}" – the fragment "${unknown}" is not recognized.`;
  }

  if (algorithm === undefined) {
    return `Invalid signature identifier. Signatures must be of the form: "[variable_id].${operationName}.[signing_serialization_type]".`;
  }

  const signingSerializationType = getSigningSerializationType(algorithm);
  if (signingSerializationType === undefined) {
    return `Unknown signing serialization algorithm, "${algorithm}".`;
  }

  const serialization = generateSigningSerializationBCH({
    correspondingOutput: operationData.correspondingOutput,
    coveredBytecode: operationData.coveredBytecode,
    locktime: operationData.locktime,
    outpointIndex: operationData.outpointIndex,
    outpointTransactionHash: operationData.outpointTransactionHash,
    outputValue: operationData.outputValue,
    sequenceNumber: operationData.sequenceNumber,
    sha256,
    signingSerializationType,
    transactionOutpoints: operationData.transactionOutpoints,
    transactionOutputs: operationData.transactionOutputs,
    transactionSequenceNumbers: operationData.transactionSequenceNumbers,
    version: operationData.version,
  });
  const digest = sha256.hash(sha256.hash(serialization));
  const bitcoinEncodedSignature = Uint8Array.from([
    ...sign(privateKey, digest),
    ...signingSerializationType,
  ]);
  return bitcoinEncodedSignature;
};

export const compilerOperationHelperHdKeySignatureBCH = ({
  operationName,
  secp256k1Method,
}: {
  operationName: string;
  secp256k1Method: keyof NonNullable<CompilationEnvironment['secp256k1']>;
}) =>
  attemptCompilerOperations(
    [compilerOperationHdKeyPrecomputedSignature],
    compilerOperationRequires({
      canBeSkipped: false,
      dataProperties: ['hdKeys', 'operationData'],
      environmentProperties: [
        'entityOwnership',
        'ripemd160',
        'secp256k1',
        'sha256',
        'sha512',
        'variables',
      ],
      operation: (identifier, data, environment) => {
        const { hdKeys, operationData } = data;
        const { secp256k1, sha256 } = environment;

        const derivationResult = compilerOperationHelperDeriveHdKeyPrivate({
          environment,
          hdKeys,
          identifier,
        });
        if (typeof derivationResult === 'string') return derivationResult;

        return compilerOperationHelperComputeSignatureBCH({
          identifier,
          operationData,
          operationName,
          privateKey: derivationResult,
          sha256,
          sign: secp256k1[secp256k1Method],
        });
      },
    })
  );

export const compilerOperationHdKeyEcdsaSignatureBCH = compilerOperationHelperHdKeySignatureBCH(
  {
    operationName: 'signature',
    secp256k1Method: 'signMessageHashDER',
  }
);
export const compilerOperationHdKeySchnorrSignatureBCH = compilerOperationHelperHdKeySignatureBCH(
  {
    operationName: 'schnorr_signature',
    secp256k1Method: 'signMessageHashSchnorr',
  }
);

export const compilerOperationHelperKeySignatureBCH = ({
  operationName,
  secp256k1Method,
}: {
  operationName: string;
  secp256k1Method: keyof NonNullable<CompilationEnvironment['secp256k1']>;
}) =>
  attemptCompilerOperations(
    [compilerOperationKeyPrecomputedSignature],
    compilerOperationRequires({
      canBeSkipped: false,
      dataProperties: ['keys', 'operationData'],
      environmentProperties: ['sha256', 'secp256k1'],
      operation: (identifier, data, environment) => {
        const { keys, operationData } = data;
        const { secp256k1, sha256 } = environment;
        const { privateKeys } = keys;
        const [variableId] = identifier.split('.');

        const privateKey =
          privateKeys === undefined ? undefined : privateKeys[variableId];

        if (privateKey === undefined) {
          return `Identifier "${identifier}" refers to a Key, but a private key for "${variableId}" (or an existing signature) was not provided in the compilation data.`;
        }

        return compilerOperationHelperComputeSignatureBCH({
          identifier,
          operationData,
          operationName,
          privateKey,
          sha256,
          sign: secp256k1[secp256k1Method],
        });
      },
    })
  );

export const compilerOperationKeyEcdsaSignatureBCH = compilerOperationHelperKeySignatureBCH(
  {
    operationName: 'signature',
    secp256k1Method: 'signMessageHashDER',
  }
);
export const compilerOperationKeySchnorrSignatureBCH = compilerOperationHelperKeySignatureBCH(
  {
    operationName: 'schnorr_signature',
    secp256k1Method: 'signMessageHashSchnorr',
  }
);

// eslint-disable-next-line complexity
export const compilerOperationHelperComputeDataSignatureBCH = <
  ProgramState,
  Data extends CompilationData<CompilerOperationDataCommon>,
  Environment extends AnyCompilationEnvironment<CompilerOperationDataCommon>
>({
  data,
  environment,
  identifier,
  operationName,
  privateKey,
  sha256,
  sign,
}: {
  data: Data;
  environment: Environment;
  identifier: string;
  privateKey: Uint8Array;
  operationName: string;
  sign: (privateKey: Uint8Array, messageHash: Uint8Array) => Uint8Array;
  sha256: { hash: Sha256['hash'] };
}) => {
  const [, , scriptId, unknown] = identifier.split('.') as [
    string,
    string | undefined,
    string | undefined,
    string | undefined
  ];

  if (unknown !== undefined) {
    return `Unknown component in "${identifier}" – the fragment "${unknown}" is not recognized.`;
  }

  if (scriptId === undefined) {
    return `Invalid data signature identifier. Data signatures must be of the form: "[variable_id].${operationName}.[target_script_id]".`;
  }

  const signingTarget = environment.scripts[scriptId] as string | undefined;

  const compiledTarget = resolveScriptIdentifier<
    CompilerOperationDataCommon,
    ProgramState
  >({
    data,
    environment,
    identifier: scriptId,
  });
  if (signingTarget === undefined || compiledTarget === false) {
    return `Data signature tried to sign an unknown target script, "${scriptId}".`;
  }
  if (typeof compiledTarget === 'string') {
    return compiledTarget;
  }

  const digest = sha256.hash(compiledTarget.bytecode);
  return sign(privateKey, digest);
};

export const compilerOperationHelperKeyDataSignatureBCH = <ProgramState>({
  operationName,
  secp256k1Method,
}: {
  operationName: string;
  secp256k1Method: keyof NonNullable<CompilationEnvironment['secp256k1']>;
}) =>
  attemptCompilerOperations(
    [compilerOperationKeyPrecomputedSignature],
    compilerOperationRequires({
      canBeSkipped: false,
      dataProperties: ['keys'],
      environmentProperties: ['sha256', 'secp256k1'],
      operation: (identifier, data, environment) => {
        const { keys } = data;
        const { secp256k1, sha256 } = environment;
        const { privateKeys } = keys;
        const [variableId] = identifier.split('.');

        const privateKey =
          privateKeys === undefined ? undefined : privateKeys[variableId];

        if (privateKey === undefined) {
          return `Identifier "${identifier}" refers to a Key, but a private key for "${variableId}" (or an existing signature) was not provided in the compilation data.`;
        }

        return compilerOperationHelperComputeDataSignatureBCH<
          ProgramState,
          typeof data,
          typeof environment
        >({
          data,
          environment,
          identifier,
          operationName,
          privateKey,
          sha256,
          sign: secp256k1[secp256k1Method],
        });
      },
    })
  );

export const compilerOperationKeyEcdsaDataSignatureBCH = compilerOperationHelperKeyDataSignatureBCH(
  {
    operationName: 'data_signature',
    secp256k1Method: 'signMessageHashDER',
  }
);
export const compilerOperationKeySchnorrDataSignatureBCH = compilerOperationHelperKeyDataSignatureBCH(
  {
    operationName: 'schnorr_data_signature',
    secp256k1Method: 'signMessageHashSchnorr',
  }
);

export const compilerOperationHelperHdKeyDataSignatureBCH = <ProgramState>({
  operationName,
  secp256k1Method,
}: {
  operationName: string;
  secp256k1Method: keyof NonNullable<CompilationEnvironment['secp256k1']>;
}) =>
  attemptCompilerOperations(
    [compilerOperationHdKeyPrecomputedSignature],
    compilerOperationRequires({
      canBeSkipped: false,
      dataProperties: ['hdKeys'],
      environmentProperties: [
        'entityOwnership',
        'ripemd160',
        'secp256k1',
        'sha256',
        'sha512',
        'variables',
      ],
      operation: (identifier, data, environment) => {
        const { hdKeys } = data;
        const { secp256k1, sha256 } = environment;

        const derivationResult = compilerOperationHelperDeriveHdKeyPrivate({
          environment,
          hdKeys,
          identifier,
        });
        if (typeof derivationResult === 'string') return derivationResult;

        return compilerOperationHelperComputeDataSignatureBCH<
          ProgramState,
          typeof data,
          typeof environment
        >({
          data,
          environment,
          identifier,
          operationName,
          privateKey: derivationResult,
          sha256,
          sign: secp256k1[secp256k1Method],
        });
      },
    })
  );

export const compilerOperationHdKeyEcdsaDataSignatureBCH = compilerOperationHelperHdKeyDataSignatureBCH(
  {
    operationName: 'data_signature',
    secp256k1Method: 'signMessageHashDER',
  }
);
export const compilerOperationHdKeySchnorrDataSignatureBCH = compilerOperationHelperHdKeyDataSignatureBCH(
  {
    operationName: 'schnorr_data_signature',
    secp256k1Method: 'signMessageHashSchnorr',
  }
);

export const compilerOperationSigningSerializationFullBCH = compilerOperationRequires(
  {
    canBeSkipped: false,
    dataProperties: ['operationData'],
    environmentProperties: ['sha256'],
    operation: (identifier, data, environment) => {
      const [, algorithmOrComponent, unknownPart] = identifier.split('.');

      if (algorithmOrComponent === undefined) {
        return `Invalid signing serialization operation. Include the desired component or algorithm, e.g. "signing_serialization.version".`;
      }

      if (unknownPart !== undefined) {
        return `Unknown component in "${identifier}" – the fragment "${unknownPart}" is not recognized.`;
      }

      const signingSerializationType = getSigningSerializationType(
        algorithmOrComponent,
        'full_'
      );
      if (signingSerializationType === undefined) {
        return `Unknown signing serialization algorithm, "${algorithmOrComponent}".`;
      }

      const { operationData } = data;
      const { sha256 } = environment;
      return generateSigningSerializationBCH({
        correspondingOutput: operationData.correspondingOutput,
        coveredBytecode: operationData.coveredBytecode,
        locktime: operationData.locktime,
        outpointIndex: operationData.outpointIndex,
        outpointTransactionHash: operationData.outpointTransactionHash,
        outputValue: operationData.outputValue,
        sequenceNumber: operationData.sequenceNumber,
        sha256,
        signingSerializationType,
        transactionOutpoints: operationData.transactionOutpoints,
        transactionOutputs: operationData.transactionOutputs,
        transactionSequenceNumbers: operationData.transactionSequenceNumbers,
        version: operationData.version,
      });
    },
  }
);

/* eslint-disable camelcase */
export const compilerOperationsBCH = {
  ...compilerOperationsCommon,
  hdKey: {
    data_signature: compilerOperationHdKeyEcdsaDataSignatureBCH,
    public_key: compilerOperationsCommon.hdKey.public_key,
    schnorr_data_signature: compilerOperationHdKeySchnorrDataSignatureBCH,
    schnorr_signature: compilerOperationHdKeySchnorrSignatureBCH,
    signature: compilerOperationHdKeyEcdsaSignatureBCH,
  },
  key: {
    data_signature: compilerOperationKeyEcdsaDataSignatureBCH,
    public_key: compilerOperationsCommon.key.public_key,
    schnorr_data_signature: compilerOperationKeySchnorrDataSignatureBCH,
    schnorr_signature: compilerOperationKeySchnorrSignatureBCH,
    signature: compilerOperationKeyEcdsaSignatureBCH,
  },
  signingSerialization: {
    ...compilerOperationsCommon.signingSerialization,
    full_all_outputs: compilerOperationSigningSerializationFullBCH,
    full_all_outputs_single_input: compilerOperationSigningSerializationFullBCH,
    full_corresponding_output: compilerOperationSigningSerializationFullBCH,
    full_corresponding_output_single_input: compilerOperationSigningSerializationFullBCH,
    full_no_outputs: compilerOperationSigningSerializationFullBCH,
    full_no_outputs_single_input: compilerOperationSigningSerializationFullBCH,
  },
};
/* eslint-enable camelcase */

export type CompilerOperationDataBCH = CompilerOperationDataCommon;
export type CompilationEnvironmentBCH = CompilationEnvironment<
  CompilerOperationDataBCH,
  CompilerOperationsKeyBCH
>;

/**
 * Create a compiler using the default BCH environment.
 *
 * Internally instantiates the necessary crypto and VM implementations – use
 * `createCompiler` for more control.
 *
 * @param scriptsAndOverrides - a compilation environment from which properties
 * will be used to override properties of the default BCH environment – must
 * include the `scripts` property
 */
export const createCompilerBCH = async <
  CompilerOperationData extends CompilerOperationDataCommon,
  Environment extends AnyCompilationEnvironment<CompilerOperationData>,
  ProgramState extends AuthenticationProgramStateBCH
>(
  scriptsAndOverrides: Environment
): Promise<Compiler<CompilerOperationData, ProgramState>> => {
  const [sha256, secp256k1, vm] = await Promise.all([
    instantiateSha256(),
    instantiateSecp256k1(),
    instantiateVirtualMachineBCH(instructionSetBCHCurrentStrict),
  ]);
  return createCompiler<CompilerOperationData, Environment, ProgramState>({
    ...{
      createState: compilerCreateStateCommon,
      opcodes: generateBytecodeMap(OpcodesBCH),
      operations: compilerOperationsBCH,
      secp256k1,
      sha256,
      vm,
    },
    ...scriptsAndOverrides,
  });
};
