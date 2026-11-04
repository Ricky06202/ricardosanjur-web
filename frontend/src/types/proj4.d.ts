declare module "proj4" {
  type Coordinate = [number, number];

  interface Proj4 {
    (source: string, destination: string, coordinate: Coordinate): Coordinate;
    defs(name: string, definition: string): void;
  }

  const proj4: Proj4;
  export default proj4;
}
