import { performance } from "node:perf_hooks";
import { MilvusClient } from "@zilliz/milvus2-sdk-node";

const { MILVUS_ADDR, MILVUS_TOKEN } = process.env;
const MAX_MILVUS_DATA_SIZE = 16384;

function chunkData(data) {
  const chunkedHashes = [];

  for (let i = 0; i < data.length; i += MAX_MILVUS_DATA_SIZE) {
    const slice = data.slice(i, i + MAX_MILVUS_DATA_SIZE);
    chunkedHashes.push(slice);
  }

  return chunkedHashes;
}

function getSearchVectors(data) {
  return data.map((hash) => [...new Int8Array(Buffer.alloc(35, hash.cl_hi, "base64")).slice(2)]);
}

export async function search(hashes, filter, limit = 1, outputFields = []) {
  const milvus = new MilvusClient({ address: MILVUS_ADDR, token: MILVUS_TOKEN });
  const results = await searchDirect(milvus, hashes, filter, limit, outputFields);
  await milvus.closeConnection();
  return results;
}

export async function searchDirect(milvus, hashes, filter, limit = 1, outputFields = []) {
  const searchVectors = getSearchVectors(hashes);
  return await searchChunked(milvus, searchVectors, filter, limit, outputFields);
}

export async function searchChunked(milvus, data, filter, limit = 1, outputFields = []) {
  const searchChunks = chunkData(data);
  let results = [];

  const startTime = performance.now();

  for (const chunk of searchChunks) {
    let searchResults = await milvus.search({
      collection_name: "frame_color_layout",
      data: chunk,
      limit,
      filter,
      output_fields: outputFields,
    });

    results = results.concat(
      searchResults.results.map((result) => {
        const [first] = result;
        return first?.score ?? null;
      }),
    );
  }

  const searchTime = (performance.now() - startTime) | 0;
  console.log(`searchTime: ${searchTime} ms, searchResult: ${results.length}`);

  return results;
}
