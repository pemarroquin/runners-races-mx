// City centroids for races with no start pin, keyed `${city}|${state}`
// exactly as races.json spells them. GENERATED, not hand-typed: each one is
// the OpenStreetMap place Nominatim returned for that city + state on
// 2026-10-25 (OSM id in the comment), kept only when Nominatim's own state
// matched the race's state. Two matches that landed on the wrong place
// (Otumba, El Marqués) were dropped, as were 8 cities Nominatim couldn't
// match — a race in a city missing here falls back to its metro centre,
// which reads as local: "unknown" is never turned into a distance.
//
// Used only to say how far a race is from its metro (regions.ts,
// raceLocation), so city-level precision is all it needs. A race's own
// `start` pin always wins over this table.
export const CITY_CENTROIDS: Record<string, [number, number]> = {
  'Akumal|Quintana Roo': [20.3988, -87.3173], // node/854200484
  'Amealco de Bonfil|Querétaro': [20.1879, -100.1447], // relation/4063321
  'Amecameca|Estado de México': [19.1249, -98.7665], // node/444566990
  'Apodaca|Nuevo León': [25.7817, -100.1888], // node/1038490154
  'Aquismón|San Luis Potosí': [21.6243, -99.0198], // node/4080629097
  'Arteaga|Coahuila': [25.4504, -100.8524], // node/808470928
  'Atizapán de Zaragoza|Estado de México': [19.5443, -99.2354], // node/10879824878
  'Atlixco|Puebla': [18.9089, -98.4378], // node/448081493
  'Atzitzintla|Puebla': [18.8981, -97.3248], // way/626780901
  'Bacalar|Quintana Roo': [18.6783, -88.3923], // relation/6431902
  'Batopilas|Chihuahua': [27.0271, -107.7392], // node/1589354814
  'Cacalchén|Yucatán': [20.9835, -89.2266], // relation/6431678
  'Cancún|Quintana Roo': [21.1527, -86.8426], // relation/17611454
  'Celaya|Guanajuato': [20.5218, -100.814], // relation/2514266
  'Chetumal|Quintana Roo': [18.5024, -88.2958], // node/269910244
  'Chihuahua|Chihuahua': [28.6369, -106.0767], // node/273587922
  'Chocholá|Yucatán': [20.75, -89.8294], // relation/6431002
  'Ciudad Juárez|Chihuahua': [31.739, -106.4832], // node/4145208823
  'Ciudad Valles|San Luis Potosí': [21.9917, -99.0103], // node/292474264
  'Ciudad de México|Ciudad de México': [19.4326, -99.1332], // relation/17483459
  'Corregidora|Querétaro': [20.5397, -100.4411], // way/814071834
  'Cozumel|Quintana Roo': [20.5014, -86.9436], // relation/6329316
  'Cuauhtémoc|Chihuahua': [28.401, -106.8665], // node/297172944
  'Ecatepec|Estado de México': [19.5994, -99.0487], // relation/5605754
  'Ensenada|Baja California': [31.8659, -116.603], // relation/4717393
  'Ezequiel Montes|Querétaro': [20.6658, -99.8979], // relation/4063575
  'Felipe Carrillo Puerto|Quintana Roo': [19.5776, -88.0463], // relation/6333261
  'Guachochi|Chihuahua': [26.8193, -107.0747], // node/1629743930
  'Guadalajara|Jalisco': [20.672, -103.3384], // node/1663173902
  'Guadalupe|Nuevo León': [25.6751, -100.2152], // node/1038661889
  'Guanajuato|Guanajuato': [21.0159, -101.2528], // node/269907416
  'Hidalgo del Parral|Chihuahua': [26.9287, -105.6674], // node/293525857
  'Huauchinango|Puebla': [20.1739, -98.0507], // node/9938388455
  'Hueypoxtla|Estado de México': [19.9074, -99.078], // node/4983969666
  'Irapuato|Guanajuato': [20.6759, -101.3521], // node/269907341
  'Ixtapan de la Sal|Estado de México': [18.8442, -99.6764], // node/291978742
  'Izamal|Yucatán': [20.9334, -89.0183], // relation/6267880
  'León|Guanajuato': [21.122, -101.683], // node/273601416
  'Malinalco|Estado de México': [18.9479, -99.4945], // way/391895349
  'Metepec|Estado de México': [19.2523, -99.6055], // node/2141796682
  'Mexicali|Baja California': [32.6393, -115.4747], // node/213601095
  'Monclova|Coahuila': [26.9, -101.4171], // node/747101009
  'Montemorelos|Nuevo León': [25.1887, -99.8294], // node/1601416420
  'Monterrey|Nuevo León': [25.6802, -100.3153], // node/4145210488
  'Moroleón|Guanajuato': [20.1305, -101.1924], // node/6403174812
  'Muna|Yucatán': [20.4858, -89.7133], // relation/6417413
  'Mérida|Yucatán': [20.9671, -89.6237], // node/269908858
  'Naucalpan de Juárez|Estado de México': [19.4788, -99.2328], // relation/5606080
  'Nopaltepec|Estado de México': [19.7787, -98.7099], // node/5322910206
  'Ocoyoacac (La Marquesa)|Estado de México': [19.2725, -99.4599], // node/2330598081
  'Oxkutzcab|Yucatán': [20.3045, -89.4167], // relation/6415990
  'Pantepec|Puebla': [20.522, -97.9391], // node/448082139
  'Piedras Negras|Coahuila': [28.6913, -100.5403], // relation/4096606
  'Playa del Carmen|Quintana Roo': [20.6463, -87.0808], // relation/6329645
  'Playas de Rosarito|Baja California': [32.3652, -117.0558], // node/3602376339
  'Progreso|Yucatán': [21.2822, -89.6637], // relation/6333853
  'Puebla|Puebla': [19.0438, -98.1982], // node/245792117
  'Rioverde|San Luis Potosí': [21.9319, -99.9929], // node/299677634
  'Saltillo|Coahuila': [25.423, -100.9928], // node/611897092
  'San Andrés Cholula|Puebla': [19.0519, -98.2976], // node/8490532245
  'San Luis Potosí|San Luis Potosí': [22.1516, -100.9764], // node/269905839
  'San Miguel de Allende|Guanajuato': [20.9142, -100.7438], // relation/2372616
  'San Nicolás de los Garza|Nuevo León': [25.7558, -100.2896], // node/1038661885
  'San Pedro Garza García|Nuevo León': [25.6652, -100.4018], // node/1038661890
  'Santa Catarina|Nuevo León': [25.6745, -100.4616], // node/1038661887
  'Santiago de Querétaro|Querétaro': [20.5923, -100.3917], // relation/4062443
  'Santiago|Nuevo León': [25.4244, -100.1513], // node/1043929322
  'Silao|Guanajuato': [20.9432, -101.4292], // relation/11208370
  'Soledad de Graciano Sánchez|San Luis Potosí': [22.1874, -100.9369], // node/679005801
  'Tecate|Baja California': [32.5654, -116.6299], // way/49431498
  'Tekax|Yucatán': [20.2052, -89.2859], // relation/6415896
  'Telchac Puerto|Yucatán': [21.3083, -89.2737], // relation/5961558
  'Temoaya|Estado de México': [19.4695, -99.595], // node/3369871167
  'Teotihuacán|Estado de México': [19.6875, -98.8757], // node/272110557
  'Tijuana|Baja California': [32.5365, -117.0371], // node/4145201092
  'Tlajomulco|Jalisco': [20.4737, -103.447], // node/2870746320
  'Tlaquepaque|Jalisco': [20.6398, -103.312], // node/1618366658
  'Tlatlauquitepec|Puebla': [19.8478, -97.497], // node/292837172
  'Toluca|Estado de México': [19.2925, -99.6569], // node/269914302
  'Torreón|Coahuila': [25.5427, -103.4105], // node/4143719537
  'Tulum|Quintana Roo': [20.4296, -87.6529], // relation/5961574
  'Umán|Yucatán': [20.8814, -89.7462], // relation/6333788
  'Urique|Chihuahua': [27.2123, -107.9147], // node/2269734473
  'Valladolid|Yucatán': [20.6903, -88.2017], // relation/5621776
  'Valle de Bravo|Estado de México': [19.1943, -100.1317], // node/273608461
  'Villa de Pozos|San Luis Potosí': [22.096, -100.8755], // node/679005800
  'Villa del Carbón|Estado de México': [19.7279, -99.4631], // node/10900967466
  'Xicotepec|Puebla': [20.2767, -97.9607], // relation/5570886
  'Zapopan|Jalisco': [20.7211, -103.3914], // node/1688949658
};
