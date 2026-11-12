export const validClabe = (value: string) =>
  /^\d{18}$/.test(value) &&
  (10 -
    ([...value.slice(0, 17)].reduce(
      (sum, digit, index) =>
        sum + ((Number(digit) * [3, 7, 1][index % 3]!) % 10),
      0,
    ) %
      10)) %
    10 ===
    Number(value[17]);
