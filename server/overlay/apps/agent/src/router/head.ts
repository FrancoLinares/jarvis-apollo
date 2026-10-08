// Clasificador local de intenciones: una regresión softmax sobre el embedding
// que el turno ya calcula para la memoria semántica. Predecir cuesta una
// multiplicación de 256 × 16: menos de un milisegundo en la Pi, sin red.
//
// Aprende por destilación. Jev hace de maestro y sus probabilidades son el
// objetivo "blando" (la misma idea que el soft cross-entropy con el que se
// entrena laya); donde el resultado del turno dejó una etiqueta, esa etiqueta
// corrige al maestro. Así el alumno puede terminar siendo mejor que Jev en las
// frases del usuario, que son las únicas que importan.
//
// No reemplaza a Jev de entrada: solo decide sola cuando está segura y cuando
// demostró, sobre turnos que no vio al entrenar, que acierta (ver learn.ts).

export type IntentHead = {
  readonly labelList: readonly string[];
  readonly dimensionCount: number;
  // labelList.length filas de dimensionCount pesos, más un sesgo por fila.
  readonly weightList: readonly (readonly number[])[];
  readonly biasList: readonly number[];
  readonly temperature: number;
};

export type HeadTrainingExample = {
  readonly features: ArrayLike<number>;
  // Distribución objetivo sobre labelList (suma 1).
  readonly target: readonly number[];
  readonly weight: number;
};

export function softmax(logitList: readonly number[], temperature = 1): number[] {
  const scaled = logitList.map((logit) => logit / temperature);
  const maximum = Math.max(...scaled);
  const exponentList = scaled.map((logit) => Math.exp(logit - maximum));
  const total = exponentList.reduce((sum, value) => sum + value, 0);
  return exponentList.map((value) => value / total);
}

export function computeHeadLogits(head: IntentHead, features: ArrayLike<number>): number[] {
  return head.weightList.map((rowWeightList, rowIndex) => {
    let logit = head.biasList[rowIndex];
    for (let index = 0; index < head.dimensionCount; index += 1) {
      logit += rowWeightList[index] * (features[index] ?? 0);
    }
    return logit;
  });
}

export function predictWithHead(
  head: IntentHead,
  features: ArrayLike<number>,
): Record<string, number> {
  const probabilityList = softmax(computeHeadLogits(head, features), head.temperature);
  return Object.fromEntries(
    head.labelList.map((label, index) => [label, probabilityList[index]]),
  );
}

// Descenso por gradiente de lotes completos con L2. Con unos cientos de
// ejemplos y 256 dimensiones alcanza y sobra. Los pesos van en arrays planos
// tipados: con arrays anidados entrenar 200 ejemplos tardaba 3,4 s en la Mac.
//
// Es asíncrono a propósito: cede el control entre épocas, así un recordatorio o
// un turno que llegue mientras entrena no queda esperando.
export async function trainIntentHead(input: {
  readonly labelList: readonly string[];
  readonly dimensionCount: number;
  readonly exampleList: readonly HeadTrainingExample[];
  readonly epochCount?: number;
  readonly learningRate?: number;
  readonly l2Penalty?: number;
  readonly yieldEveryEpochs?: number;
}): Promise<IntentHead> {
  const classCount = input.labelList.length;
  const dimensionCount = input.dimensionCount;
  const epochCount = input.epochCount ?? 300;
  const learningRate = input.learningRate ?? 2;
  const l2Penalty = input.l2Penalty ?? 1e-3;
  const yieldEveryEpochs = input.yieldEveryEpochs ?? 5;
  const exampleCount = input.exampleList.length;

  const featureMatrix = new Float64Array(exampleCount * dimensionCount);
  const targetMatrix = new Float64Array(exampleCount * classCount);
  const exampleWeightList = new Float64Array(exampleCount);
  input.exampleList.forEach((example, exampleIndex) => {
    for (let index = 0; index < dimensionCount; index += 1) {
      featureMatrix[exampleIndex * dimensionCount + index] = example.features[index] ?? 0;
    }
    for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
      targetMatrix[exampleIndex * classCount + classIndex] = example.target[classIndex] ?? 0;
    }
    exampleWeightList[exampleIndex] = example.weight;
  });
  const totalWeight = exampleWeightList.reduce((sum, value) => sum + value, 0) || 1;

  const weightMatrix = new Float64Array(classCount * dimensionCount);
  const biasVector = new Float64Array(classCount);
  const gradientMatrix = new Float64Array(classCount * dimensionCount);
  const gradientBias = new Float64Array(classCount);
  const logitVector = new Float64Array(classCount);

  for (let epoch = 0; epoch < epochCount; epoch += 1) {
    gradientMatrix.fill(0);
    gradientBias.fill(0);
    for (let exampleIndex = 0; exampleIndex < exampleCount; exampleIndex += 1) {
      const featureOffset = exampleIndex * dimensionCount;
      let maximum = Number.NEGATIVE_INFINITY;
      for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
        let logit = biasVector[classIndex];
        const weightOffset = classIndex * dimensionCount;
        for (let index = 0; index < dimensionCount; index += 1) {
          logit += weightMatrix[weightOffset + index] * featureMatrix[featureOffset + index];
        }
        logitVector[classIndex] = logit;
        if (logit > maximum) {
          maximum = logit;
        }
      }
      let total = 0;
      for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
        logitVector[classIndex] = Math.exp(logitVector[classIndex] - maximum);
        total += logitVector[classIndex];
      }
      const exampleWeight = exampleWeightList[exampleIndex];
      for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
        const error =
          (logitVector[classIndex] / total - targetMatrix[exampleIndex * classCount + classIndex]) *
          exampleWeight;
        gradientBias[classIndex] += error;
        const weightOffset = classIndex * dimensionCount;
        for (let index = 0; index < dimensionCount; index += 1) {
          gradientMatrix[weightOffset + index] += error * featureMatrix[featureOffset + index];
        }
      }
    }
    for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
      biasVector[classIndex] -= (learningRate * gradientBias[classIndex]) / totalWeight;
    }
    for (let index = 0; index < weightMatrix.length; index += 1) {
      weightMatrix[index] -=
        learningRate * (gradientMatrix[index] / totalWeight + l2Penalty * weightMatrix[index]);
    }
    if ((epoch + 1) % yieldEveryEpochs === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return {
    labelList: [...input.labelList],
    dimensionCount,
    weightList: Array.from({ length: classCount }, (_, classIndex) =>
      Array.from(weightMatrix.subarray(classIndex * dimensionCount, (classIndex + 1) * dimensionCount)),
    ),
    biasList: Array.from(biasVector),
    temperature: 1,
  };
}

// Calibración posterior: la misma temperatura única que laya ajusta después de
// entrenar. Un clasificador chico entrenado con pocos datos suele salir
// sobreconfiado, y el router decide por umbrales de probabilidad, así que la
// probabilidad tiene que significar lo que dice.
export function fitHeadTemperature(
  head: IntentHead,
  exampleList: readonly { readonly features: ArrayLike<number>; readonly labelIndex: number }[],
): number {
  if (exampleList.length === 0) {
    return 1;
  }
  const logitCache = exampleList.map((example) => computeHeadLogits(head, example.features));
  let bestTemperature = 1;
  let bestLoss = Number.POSITIVE_INFINITY;
  for (let temperature = 0.5; temperature <= 5.0001; temperature += 0.1) {
    let loss = 0;
    for (let index = 0; index < exampleList.length; index += 1) {
      const probabilityList = softmax(logitCache[index], temperature);
      loss -= Math.log(Math.max(probabilityList[exampleList[index].labelIndex], 1e-9));
    }
    if (loss < bestLoss) {
      bestLoss = loss;
      bestTemperature = Math.round(temperature * 10) / 10;
    }
  }
  return bestTemperature;
}
